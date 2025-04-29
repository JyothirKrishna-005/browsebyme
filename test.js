/**
 * Test script for BrowseByMe
 * Run this with: node test.js
 */
const dotenv = require('dotenv');
const path = require('path');
const { logger } = require('./src/utils/logger');
const BrowserController = require('./src/browser/browserController');
const CommandParser = require('./src/commands/commandParser');

// Load environment variables
dotenv.config();

// Initialize browser controller and command parser
const browserController = new BrowserController();
const commandParser = new CommandParser(browserController);

// Define a list of test commands
const testCommands = [
  'open chrome',
  'go to google.com',
  'type "BrowseByMe automation" in the search box',
  'click the search button',
  'wait 3 seconds',
  'click on the first result',
  'wait 3 seconds',
  'take a screenshot',
  'close browser'
];

// Function to run a command
async function runCommand(command) {
  try {
    logger.info(`Running test command: ${command}`);
    const result = await commandParser.parseAndExecute(command);
    logger.info(`Command result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    logger.error(`Command error: ${error.message}`);
    return { error: error.message };
  }
}

// Run the tests in sequence
async function runTests() {
  logger.info('Starting BrowseByMe test script');
  
  // Add delay between commands
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  
  for (const command of testCommands) {
    await runCommand(command);
    // Wait 1 second between commands to avoid overwhelming the browser
    await delay(1000);
  }
  
  logger.info('Test script completed');
  process.exit(0);
}

// Run the tests
runTests().catch(error => {
  logger.error(`Test script error: ${error.message}`);
  process.exit(1);
}); 