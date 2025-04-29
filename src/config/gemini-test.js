/**
 * Gemini API Test Script
 * 
 * To run this script: 
 * 1. Set your GEMINI_API_KEY in .env
 * 2. Run with node src/config/gemini-test.js
 */
require('dotenv').config();
const GeminiService = require('../utils/geminiService');

// Sample browser state for testing
const sampleState = {
  url: 'https://www.amazon.in',
  title: 'Amazon.in - Online Shopping for Electronics, Apparel, Computers, Books, DVDs & more',
  browserType: 'chrome',
  activeSessionId: 'chrome-123456789'
};

// Sample commands to test
const testCommands = [
  'go to amazon.in',
  'search for iphone 14',
  'click on the first result',
  'add to cart',
  'go to checkout'
];

// Test function
async function testGeminiAPI() {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('No GEMINI_API_KEY found in .env file');
    console.log('Please add your API key to .env file as GEMINI_API_KEY=your_key_here');
    process.exit(1);
  }
  
  console.log('Testing Gemini AI integration...');
  const geminiService = new GeminiService(apiKey);
  
  // Allow time for system instructions to load
  await new Promise(r => setTimeout(r, 1000));
  
  // Test each command
  for (const command of testCommands) {
    console.log(`\nTesting command: "${command}"`);
    try {
      const result = await geminiService.processCommand(command, sampleState);
      console.log('Gemini AI response:');
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`Error processing command: ${error.message}`);
    }
  }
  
  console.log('\nTest completed!');
}

// Run the test
testGeminiAPI().catch(console.error); 