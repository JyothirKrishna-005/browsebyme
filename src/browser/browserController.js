/**
 * Browser Controller - Manages browser instances and provides automation methods
 */
const { chromium, firefox, webkit } = require('playwright');
const { logger } = require('../utils/logger');
const config = require('../config/config');

class BrowserController {
  constructor() {
    this.browsers = new Map(); // Map to store active browser instances
    this.defaultBrowser = config.browser.defaultType || 'chromium';
    this.defaultTimeout = config.browser.defaultTimeout || 30000;
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
      
      // Create a context with more realistic viewport
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        acceptDownloads: true,
        // Add permissions for notifications, etc.
        permissions: ['notifications', 'geolocation']
      });
      
      // Set default timeout
      context.setDefaultTimeout(this.defaultTimeout);
      
      const page = await context.newPage();
      
      // Handle dialogs automatically
      page.on('dialog', async dialog => {
        logger.info(`Auto-accepting dialog: ${dialog.message()}`);
        await dialog.accept();
      });
      
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
      
      // Make sure URL has protocol
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }
      
      // Wait until network is idle to ensure page is fully loaded
      const response = await session.page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: this.defaultTimeout 
      });
      
      // Wait additional time for SPAs and dynamic content
      await session.page.waitForTimeout(1000);
      
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
      
      // Wait for the element to be visible before interacting
      await session.page.waitForSelector(selector, { state: 'visible', timeout: this.defaultTimeout });
      
      // Clear the field first (if it's not empty)
      await session.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) element.value = '';
      }, selector);
      
      // Fill the field
      await session.page.fill(selector, value);
      
      // Trigger change event to ensure JavaScript detects the change
      await session.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) {
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, selector);
      
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
      
      // First try to find element with exact selector
      let elementVisible = await this.isElementVisible(selector, sessionId);
      
      // If not found, try looser selectors
      if (!elementVisible) {
        // Try various fallback approaches
        const alternativeSelectors = this.generateAlternativeSelectors(selector);
        
        for (const altSelector of alternativeSelectors) {
          elementVisible = await this.isElementVisible(altSelector, sessionId);
          if (elementVisible) {
            logger.info(`Using alternative selector: ${altSelector}`);
            selector = altSelector;
            break;
          }
        }
      }
      
      if (!elementVisible) {
        throw new Error(`Element ${selector} not found or not visible`);
      }
      
      // Wait for the element to be enabled/clickable
      await session.page.waitForSelector(selector, { 
        state: 'visible', 
        timeout: this.defaultTimeout 
      });
      
      // Scroll element into view
      await session.page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, selector);
      
      // Wait a brief moment for any animations to complete
      await session.page.waitForTimeout(500);
      
      // Click the element
      await session.page.click(selector);
      
      // Wait a moment for any page changes to start
      await session.page.waitForTimeout(500);
      
      logger.info(`Clicked element: ${selector} (${sessionId})`);
      return { success: true, selector };
    } catch (error) {
      logger.error(`Click element error: ${error.message}`);
      throw new Error(`Failed to click element ${selector}: ${error.message}`);
    }
  }

  /**
   * Check if an element is visible
   * @param {string} selector - Element selector
   * @param {string} sessionId - Browser session ID
   * @returns {boolean} Whether the element is visible
   */
  async isElementVisible(selector, sessionId) {
    try {
      const session = this.getSession(sessionId);
      return await session.page.isVisible(selector, { timeout: 1000 });
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate alternative selectors for an element
   * @param {string} originalSelector - Original selector
   * @returns {Array} Array of alternative selectors
   */
  generateAlternativeSelectors(originalSelector) {
    const alternatives = [];
    
    // If it's a button selector, try common button patterns
    if (originalSelector.includes('button')) {
      alternatives.push('button');
      alternatives.push('button:visible');
      alternatives.push('[type="button"]');
      alternatives.push('[role="button"]');
      alternatives.push('.btn');
      alternatives.push('.button');
    }
    
    // If it's a link selector, try common link patterns
    if (originalSelector.includes('a')) {
      alternatives.push('a');
      alternatives.push('a:visible');
      alternatives.push('[href]');
    }
    
    // If it's a form field, try common field patterns
    if (originalSelector.includes('input')) {
      alternatives.push('input');
      alternatives.push('input:visible');
      alternatives.push('textarea');
    }
    
    // If it's a search field
    if (originalSelector.includes('search') || originalSelector.includes('[name="q"]')) {
      alternatives.push('input[type="search"]');
      alternatives.push('input[name="q"]');
      alternatives.push('input[placeholder*="search" i]');
      alternatives.push('[aria-label*="search" i]');
    }
    
    // Submit buttons
    if (originalSelector.includes('submit')) {
      alternatives.push('[type="submit"]');
      alternatives.push('button[type="submit"]');
      alternatives.push('input[type="submit"]');
      alternatives.push('button:contains("Search")');
      alternatives.push('button:contains("Submit")');
      alternatives.push('button:contains("Go")');
    }
    
    return alternatives;
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
      const screenshot = await session.page.screenshot({ fullPage: true });
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