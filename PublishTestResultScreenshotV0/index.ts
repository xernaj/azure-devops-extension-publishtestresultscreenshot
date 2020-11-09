// **********************************************************************************
// ************************* FOR LOCAL USE ******************************************
// process.env.ENDPOINT_AUTH_PARAMETER_SYSTEMVSSCONNECTION_ACCESSTOKEN=""
// process.env.SYSTEM_TEAMPROJECT = ""
// process.env.INPUT_ORGANIZATION = ""
// process.env.INPUT_SCREENSHOTFOLDER = ""
// process.env.INPUT_OSTYPE = "android|ios"
// process.env.INPUT_SCREENSHOTROTATEANGLE = "0|90"
// process.env.BUILD_BUILDID = ""
// **********************************************************************************

import * as tl from "azure-pipelines-task-lib/task"
import * as azdev from "azure-devops-node-api";
import * as ta from "azure-devops-node-api/TestApi";
import fs from "fs";
import glob from "glob";
import Jimp from "jimp";
import { TestOutcome, ShallowTestCaseResult, TestAttachmentRequestModel, TestAttachmentReference } from 'azure-devops-node-api/interfaces/TestInterfaces';

const DEFAULT_SCREENSHOT_FOLDER = "./app/build/reports/androidTests/connected/screenshots/failures/";
const PARAM_SCREENSHOT_FOLDER = "screenshotFolder";
const DEFAULT_OS_TYPE = "android";
const PARAM_OS_TYPE = "osType";
const DEFAULT_SCREENSHOT_ROTATE = "0";
const PARAM_SCREENSHOT_ROTATE = "screenshotRotateAngle";
const PARAM_ORGANIZATION = "organization";

let project = tl.getVariable("System.TeamProject");
let testApi: ta.ITestApi

async function run() {
    try {
        let authToken = tl.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false);
        let authHandler = azdev.getPersonalAccessTokenHandler(authToken);
        let connection = new azdev.WebApi("https://dev.azure.com/" + getOrganization(), authHandler);
        testApi = await connection.getTestApi();
        await testApi.getTestResultsByBuild(project, +tl.getVariable("Build.BuildId"), undefined, [TestOutcome.Failed])
            .then(async failedTests => uploadScreenshots(failedTests))
            .catch(err => tl.setResult(tl.TaskResult.Failed, err.message))
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

run();

async function uploadScreenshots(failedTests: ShallowTestCaseResult[]) {
    let apiCalls: Promise<any>[] = [];
    let missingScreenshots: Error[] = [];
    let totalFailures = failedTests.length
    
    if(totalFailures <= 0) {
        tl.setResult(tl.TaskResult.Skipped, "No test failures found.")
        return
    }
    console.log(totalFailures + " tests failed. Will proceed with screenshot upload.")
    for (const failedTest of failedTests) {
        // can't use .forEach with async here as that will fire off the calls before Promise.all(apiCalls) can count all the results
        // eg. it will result in weird results like "Task completed. Published 0/1 screenshots" even though 1 screenshot was published
        // see https://stackoverflow.com/questions/37576685/using-async-await-with-a-foreach-loop
        let testName = failedTest.automatedTestName;
        let className = failedTest.automatedTestStorage;
        let testTitle = failedTest.testCaseTitle;

        tl.debug("testName: "+testName+"|className: "+className+"|test case title: "+testTitle);

        let imageExtension = getOsType() == "ios" ? ".jpg" : ".png";

        var imgPath;
        if (getOsType() == "ios") {
            // classname for xcode is sometimes "appName.class eg. MyApp.UITests
            // xcparse output is class/testname() eg. UITests/testOne()/*.jpg
            var xcodeClass;
            let splitClass = className?.split(".");
            if (splitClass?.length == 2) { // handle directory "{appName}.{class}"
                xcodeClass = splitClass[1];
            } else { // handle directory "{class}"
                xcodeClass = className
            }

            let dirSearch = getScreenshotFolder() + xcodeClass + "/" + testName + "*/" + "*.jpg";

            // supports only one screenshot even if folder has many
            var files = glob.sync(dirSearch);
            if (files != undefined && files.length > 0) {
                console.log("found files "+files.length)
                console.log("choosing first: "+files[0])
                imgPath = files[0]
            } else {
                imgPath = ""
            }
        } else {
            imgPath = getScreenshotFolder() + className + "/" + testName + imageExtension;//TODO make it configurable in upcoming version
        }

        tl.debug("Searching for image at path: " + imgPath);
        if (fs.existsSync(imgPath)) {
            var imageAsBase64 = ""
            
            const rotateAngle = getScreenShotRotate()
            const image = await Jimp.read(imgPath);
            const base64String = await image.rotate(rotateAngle).getBase64Async(image.getMIME());
            if (base64String != undefined) {
                // Jimp creates base 64 with media type eg. "data:image/jpeg;base64,/9j/", we'll need to split the comma or there'll be an error from rest client "Error: Unable to obtain Stream"
                imageAsBase64 = base64String.split(',').pop() || "";
            } else {
                tl.debug("Image could not be loaded at path: " + imgPath);
            }

            let attachment: TestAttachmentRequestModel = {fileName: testName + imageExtension, stream: imageAsBase64};
            
            apiCalls.push(testApi.createTestResultAttachment(attachment, project, failedTest.runId!, failedTest.id!));
        } else {
            tl.debug("Failure - No screenshot found for " + className + "/" + testName);
            missingScreenshots.push(Error("No screenshot found for " + className + "/" + testName));
        }
    }
    Promise.all(apiCalls).then(function(attachmentResults) {
        let attachmentFailedCount = attachmentResults.filter(attachmentResult => attachmentResult == null).length
        let hasMissingScreenshot = missingScreenshots.length > 0
        let hasAttachmentFailure = attachmentFailedCount > 0

        tl.debug("hasMissingScreenshot: " + hasMissingScreenshot + " -- hasAttachmentFailure: " + hasAttachmentFailure)
        if (hasMissingScreenshot || hasAttachmentFailure) {
            let message = ""
            if (hasMissingScreenshot) message += (totalFailures != missingScreenshots.length ? "Some screenshots were missing. " : "All screenshots were missing. ");
            if (hasAttachmentFailure) message += (totalFailures != attachmentFailedCount) ? "Some attachments failed. " : "All attachments failed. "

            tl.setResult(tl.TaskResult.SucceededWithIssues, message);
        } else {
            attachmentResults.forEach(attachmentResult => tl.debug("attachment success-> " + (attachmentResult as TestAttachmentReference).url))
            tl.setResult(tl.TaskResult.Succeeded, "All screenshots were published successfully");
        }
        console.log("Task completed. Published " + (attachmentResults.length - attachmentFailedCount) + "/" + totalFailures + " screenshots")
    })
}

/**
 * Get the input parameter "screenshotFolder"
 * 
 * @returns the value from the input param or DEFAULT_SCREENSHOT_FOLDER
 */
function getScreenshotFolder(): string {
    let screenshotFolder = tl.getInput(PARAM_SCREENSHOT_FOLDER)
    if (isNullEmptyOrUndefined(screenshotFolder)) {
        return DEFAULT_SCREENSHOT_FOLDER
    } else {
        return screenshotFolder += screenshotFolder.endsWith("/") ? "" : "/"
    }
}

/**
 * Get the input parameter "osType"
 * 
 * @returns the value from the input param or DEFAULT_OS_TYPE
 */
function getOsType(): string {
    let osType = tl.getInput(PARAM_OS_TYPE)
    if (isNullEmptyOrUndefined(osType)) {
        return DEFAULT_OS_TYPE
    } else {
        return osType
    }
}

/**
 * Get the input parameter "screenshotRotate"
 * 
 * @returns the value from the input param or DEFAULT_SCREENSHOT_ROTATE
 */
function getScreenShotRotate(): number {
    let screenShotRotate = tl.getInput(PARAM_SCREENSHOT_ROTATE)
    if (isNullEmptyOrUndefined(screenShotRotate)) {
        return parseInt(DEFAULT_SCREENSHOT_ROTATE) || 0
    } else {
        return parseInt(screenShotRotate) || 0
    }
}

/**
 * Get the input parameter "organization" in order to make REST calls
 * 
 * **NOTE**: this is needed until a System.OrganizationName is exposed (*see: https://developercommunity.visualstudio.com/idea/747962/add-a-variable-to-access-organization-name.html*)
 * 
 * @returns the organization
 * @throws an error if no value was given
 */
function getOrganization(): string {
    let organization = tl.getInput(PARAM_ORGANIZATION)
    if (isNullEmptyOrUndefined(organization)) {
        throw Error("Organization is mandatory")
    } else {
        return organization
    }
}

/**
 * Test the given parameter to see if it's usable.
 * 
 * @param obj the obj to test
 * @returns true if the param is neither either null, empty, or undefined
 */
function isNullEmptyOrUndefined(obj: any): boolean {
    return obj === null || obj === '' || obj === undefined
}