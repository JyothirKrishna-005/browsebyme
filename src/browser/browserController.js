/**
 * Browser Controller - Manages browser instances and provides automation methods
 */
const { chromium, firefox, webkit } = require('playwright');
const { logger } = require('../utils/logger');

class BrowserController {
  constructor() {
    this.browsers = new Map(); // Map to store active browser instances
    this.defaultBrowser = 'chromium';
  }

  /**
   * Launch a new browser instance
   * @param {string} browserType - Type of browser (chromium, firefox, webkit)
   * @param {object} options - Browser launch options
   * @returns {object} Browser session information
   */
  async launchBrowser(browserType = this.defaultBrowser, options = {}) {
    try {
      const sessionId = `${browserType}-${Date.now()}`;
      
      // Select browser based on type
      let browser;
      switch (browserType.toLowerCase()) {
        case 'firefox':
          browser = await firefox.launch({ headless: false, ...options });
          break;
        case 'webkit':
        case 'safari':
          browser = await webkit.launch({ headless: false, ...options });
          break;
        case 'chromium':
        case 'chrome':
        case 'edge':
        default:
          browser = await chromium.launch({ headless: false, ...options });
      }
      
      const context = await browser.newContext();
      const page = await context.newPage();
      
      // Store browser session
      this.browsers.set(sessionId, { 
        browser, 
        context, 
        page, 
        type: browserType,
        createdAt: new Date()
      });
      
      logger.info(`Browser launched: ${browserType} (${sessionId})`);
      
      return {
        sessionId,
        type: browserType
      };
    } catch (error) {
      logger.error(`Failed to launch browser: ${error.message}`);
      throw new Error(`Failed to launch browser: ${error.message}`);
    }
  }

  /**
   * Navigate to a URL
   * @param {string} url - URL to navigate to
   * @param {string} sessionId - Browser session ID
   * @returns {object} Navigation result
   */
  async navigateTo(url, sessionId) {
    try {
      const session = this.getSession(sessionId);
      const response = await session.page.goto(url, { waitUntil: 'domcontentloaded' });
      logger.info(`Navigated to: ${url} (${sessionId})`);
      
      return {
        url: response.url(),
        status: response.status(),
        title: await session.page.title()
      };
    } catch (error) {
      logger.error(`Navigation error: ${error.message}`);
      throw new Error(`Failed to navigate to ${url}: ${error.message}`);
    }
  }

  /**
   * Fill a form field
   * @param {string} selector - Element selector
   * @param {string} value - Value to enter
   * @param {string} sessionId - Browser session ID
   */
  async fillField(selector, value, sessionId) {
    try {
      const session = this.getSession(sessionId);
      await session.page.fill(selector, value);
      logger.info(`Filled field: ${selector} (${sessionId})`);
      return { success: true, selector };
    } catch (error) {
      logger.error(`Fill field error: ${error.message}`);
      throw new Error(`Failed to fill field ${selector}: ${error.message}`);
    }
  }

  /**
   * Click on an element
   * @param {string} selector - Element selector
   * @param {string} sessionId - Browser session ID
   */
  async clickElement(selector, sessionId) {
    try {
      const session = this.getSession(sessionId);
      await session.page.click(selector);
      logger.info(`Clicked element: ${selector} (${sessionId})`);
      return { success: true, selector };
    } catch (error) {
      logger.error(`Click element error: ${error.message}`);
      throw new Error(`Failed to click element ${selector}: ${error.message}`);
    }
  }

  /**
   * Execute JavaScript in the browser
   * @param {string} script - JavaScript to execute
   * @param {string} sessionId - Browser session ID
   * @returns {any} Result of the script execution
   */
  async executeScript(script, sessionId) {
    try {
      const session = this.getSession(sessionId);
      const result = await session.page.evaluate(script);
      logger.info(`Executed script (${sessionId})`);
      return { success: true, result };
    } catch (error) {
      logger.error(`Script execution error: ${error.message}`);
      throw new Error(`Failed to execute script: ${error.message}`);
    }
  }

  /**
   * Take a screenshot
   * @param {string} sessionId - Browser session ID
   * @returns {Buffer} Screenshot as Buffer
   */
  async takeScreenshot(sessionId) {
    try {
      const session = this.getSession(sessionId);
      const screenshot = await session.page.screenshot();
      logger.info(`Took screenshot (${sessionId})`);
      return screenshot;
    } catch (error) {
      logger.error(`Screenshot error: ${error.message}`);
      throw new Error(`Failed to take screenshot: ${error.message}`);
    }
  }

  /**
   * Close a browser session
   * @param {string} sessionId - Browser session ID to close
   */
  async closeBrowser(sessionId) {
    try {
      const session = this.getSession(sessionId);
      await session.browser.close();
      this.browsers.delete(sessionId);
      logger.info(`Browser closed: ${sessionId}`);
      return { success: true };
    } catch (error) {
      logger.error(`Close browser error: ${error.message}`);
      throw new Error(`Failed to close browser: ${error.message}`);
    }
  }

  /**
   * Close all active browser sessions
   */
  async closeAll() {
    try {
      const promises = [];
      for (const sessionId of this.browsers.keys()) {
        promises.push(this.closeBrowser(sessionId));
      }
      await Promise.all(promises);
      logger.info('All browsers closed');
      return { success: true };
    } catch (error) {
      logger.error(`Close all browsers error: ${error.message}`);
      throw new Error(`Failed to close all browsers: ${error.message}`);
    }
  }

  /**
   * Get a browser session
   * @param {string} sessionId - Browser session ID
   * @returns {object} Browser session object
   */
  getSession(sessionId) {
    const session = this.browsers.get(sessionId);
    if (!session) {
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    return session;
  }

  /**
   * List all active browser sessions
   * @returns {Array} Array of active sessions
   */
  listSessions() {
    const sessions = [];
    for (const [id, session] of this.browsers.entries()) {
      sessions.push({
        sessionId: id,
        type: session.type,
        createdAt: session.createdAt
      });
    }
    return sessions;
  }
}

module.exports = BrowserController; 