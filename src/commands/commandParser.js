/**
 * Command Parser - Interprets text commands and calls appropriate browser actions
 */
const natural = require('natural');
const { logger } = require('../utils/logger');
const { extractEntities } = require('../utils/nlpHelper');
const GeminiService = require('../utils/geminiService');

class CommandParser {
  constructor(browserController) {
    this.browserController = browserController;
    this.activeSession = null;
    this.tokenizer = new natural.WordTokenizer();
    
    // Initialize Gemini AI service if API key exists
    const geminiApiKey = process.env.GEMINI_API_KEY;
    this.geminiService = new GeminiService(geminiApiKey);
    
    // Command patterns for basic intent recognition (used as fallback)
    this.commandPatterns = {
      open: [
        'open', 'launch', 'start', 'create', 'new'
      ],
      navigate: [
        'go to', 'navigate to', 'visit', 'open', 'browse', 'load'
      ],
      click: [
        'click', 'press', 'select', 'choose', 'tap', 'push'
      ],
      type: [
        'type', 'enter', 'input', 'fill', 'write'
      ],
      search: [
        'search', 'find', 'look for', 'query'
      ],
      book: [
        'book', 'reserve', 'purchase', 'buy'
      ],
      close: [
        'close', 'exit', 'quit', 'end'
      ],
      screenshot: [
        'screenshot', 'capture', 'take picture', 'snap'
      ],
      scroll: [
        'scroll', 'move', 'swipe'
      ],
      wait: [
        'wait', 'pause', 'delay', 'sleep'
      ]
    };
  }

  /**
   * Parse and execute a text command
   * @param {string} command - Text command to execute
   * @returns {object} Command execution result
   */
  async parseAndExecute(command) {
    try {
      logger.info(`Parsing command: ${command}`);
      
      // Get current state for context with extended page information
      const currentState = await this.getEnhancedState();
      
      // Use Gemini AI to process the command if available
      let aiResult = null;
      try {
        aiResult = await this.geminiService.processCommand(command, currentState);
        logger.info(`AI processed command: ${JSON.stringify(aiResult)}`);
      } catch (aiError) {
        logger.error(`AI processing error: ${aiError.message}`);
        // Will fall back to regular processing
      }
      
      // If AI provided a valid result, use it (could be a single action or an array of actions)
      if (aiResult && aiResult.action && aiResult.action !== 'unknown') {
        return await this.executeAICommand(aiResult);
      } else if (Array.isArray(aiResult) && aiResult.length > 0) {
        // Handle action sequences - execute them in order
        const results = [];
        for (const action of aiResult) {
          const result = await this.executeAICommand(action);
          results.push(result);
          // Brief pause between actions
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        return {
          action: 'sequence',
          steps: results.length,
          message: `Executed ${results.length} sequential actions`
        };
      }
      
      // Fall back to traditional processing
      // Normalize command to lowercase
      const normalizedCommand = command.toLowerCase();
      
      // Determine the intent of the command
      const intent = this.determineIntent(normalizedCommand);
      logger.info(`Detected intent: ${intent.type}`);
      
      // Execute command based on intent
      return await this.executeCommand(normalizedCommand, this.activeSession);
    } catch (error) {
      logger.error(`Command parser error: ${error.message}`);
      throw new Error(`Failed to parse command: ${error.message}`);
    }
  }

  /**
   * Get enhanced current browser state with page structure details
   * @returns {object} Enhanced current state
   */
  async getEnhancedState() {
    const baseState = this.getCurrentState();
    
    if (!this.activeSession) {
      return baseState;
    }
    
    try {
      const session = this.browserController.getSession(this.activeSession);
      
      // Get page structure for more comprehensive analysis
      const pageStructure = await this.browserController.getPageStructure(this.activeSession);
      
      // Get more detailed information about visible elements
      const visibleElements = pageStructure.visibleElements.map(el => {
        let desc = el.tag;
        
        // Add name if available
        if (el.name) desc += ` name="${el.name}"`;
        
        // Add text if it's not too long
        if (el.textContent && el.textContent.length < 30) {
          desc += ` "${el.textContent.trim()}"`;
        }
        
        // Add type for input elements
        if (el.type) desc += ` type="${el.type}"`;
        
        // Add ID if available
        if (el.id) desc += ` id="${el.id}"`;
        
        // Add placeholder for input fields
        if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
        
        return desc;
      }).filter(Boolean).slice(0, 15);
      
      // Extract form information
      const formInfo = pageStructure.forms.map(form => {
        const fieldInfo = form.fields.map(field => 
          `${field.type || 'field'} name="${field.name || ''}" id="${field.id || ''}"`
        ).join(', ');
        
        return `Form${form.id ? ' id="' + form.id + '"' : ''}${form.name ? ' name="' + form.name + '"' : ''} fields: [${fieldInfo}]`;
      }).join('\n');
      
      // Extract canvas information
      const canvasInfo = pageStructure.canvasElements.map(canvas => 
        `Canvas${canvas.id ? ' id="' + canvas.id + '"' : ''} ${canvas.width}x${canvas.height}`
      ).join('\n');
      
      // Get a simplified DOM structure
      const domSnapshot = await session.page.evaluate(() => {
        // Get the main content area
        const main = document.querySelector('main') || document.querySelector('body');
        
        // Helper function to get a simplified element structure
        function getSimpleStructure(el, depth = 0) {
          if (!el || depth > 3) return ''; // Limit depth
          
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
          
          // Get element text if not too long
          const text = el.innerText || el.textContent || '';
          const shortText = text && text.length < 30 ? `: "${text.trim()}"` : '';
          
          let result = '  '.repeat(depth) + `<${tag}${id}${name}${shortText}>`;
          
          if (depth < 3) {
            // Only process a limited number of children to avoid huge output
            const children = Array.from(el.children).slice(0, 3);
            if (children.length > 0) {
              result += '\n';
              for (const child of children) {
                result += getSimpleStructure(child, depth + 1) + '\n';
              }
              result += '  '.repeat(depth) + `</${tag}>`;
            }
          }
          
          return result;
        }
        
        return getSimpleStructure(main);
      });
      
      return {
        ...baseState,
        visibleElements,
        formInfo: formInfo || 'No forms detected',
        canvasInfo: canvasInfo || 'No canvas elements detected',
        domSnapshot: domSnapshot.length > 2000 ? domSnapshot.substring(0, 2000) + '...' : domSnapshot,
        focusedElementInfo: pageStructure.focusedElement ? 
          `Focused: ${pageStructure.focusedElement.tag}${pageStructure.focusedElement.id ? ' id="' + pageStructure.focusedElement.id + '"' : ''}${pageStructure.focusedElement.name ? ' name="' + pageStructure.focusedElement.name + '"' : ''}` 
          : 'No element focused'
      };
    } catch (error) {
      logger.warn(`Failed to get enhanced state: ${error.message}`);
      return baseState;
    }
  }

  /**
   * Get current browser state for context
   * @returns {object} Current state
   */
  getCurrentState() {
    const state = {
      activeSessionId: this.activeSession
    };
    
    if (this.activeSession) {
      try {
        const session = this.browserController.getSession(this.activeSession);
        state.browserType = session.type;
        state.url = session.page.url();
        state.title = session.page.title();
      } catch (error) {
        // Silent error - we'll just have less context
      }
    }
    
    return state;
  }

  /**
   * Execute a command from AI processing
   * @param {object} aiCommand - AI processed command
   * @returns {object} Command execution result
   */
  async executeAICommand(aiCommand) {
    try {
      if (!aiCommand || typeof aiCommand !== 'object') {
        throw new Error('Invalid AI command format');
      }
      
      const action = aiCommand.action;
      if (!action) {
        throw new Error('AI command missing required action field');
      }
      
      logger.info(`Executing AI command: ${action}`);
      
      switch (action.toLowerCase()) {
        case 'navigate':
        case 'go':
          // Ensure URL is provided and valid
          if (!aiCommand.url) {
            throw new Error('Navigate command missing required URL');
          }
          
          // Ensure URL has protocol
          let url = aiCommand.url;
          if (!url.startsWith('http')) {
            url = 'https://' + url;
          }
          
          return await this.browserController.navigateTo(url, this.activeSession);
          
        case 'click':
          // Ensure target or selector is provided
          const clickTarget = aiCommand.selector || aiCommand.target;
          if (!clickTarget) {
            throw new Error('Click command missing required selector or target');
          }
          
          return await this.browserController.clickElement(clickTarget, this.activeSession);
          
        case 'type':
        case 'fill':
        case 'input':
          // Ensure both field and value are provided
          const typeTarget = aiCommand.selector || aiCommand.field || aiCommand.target;
          const typeValue = aiCommand.value || aiCommand.text;
          
          if (!typeTarget) {
            throw new Error('Type command missing required selector or field');
          }
          
          if (typeValue === undefined || typeValue === null) {
            throw new Error('Type command missing required value or text');
          }
          
          return await this.browserController.fillField(typeTarget, typeValue.toString(), this.activeSession);
          
        case 'search':
          // Ensure query is provided
          const searchQuery = aiCommand.query || aiCommand.text || aiCommand.value;
          if (!searchQuery) {
            throw new Error('Search command missing required query');
          }
          
          const searchField = aiCommand.selector || aiCommand.field || 'input[type="search"], input[name="q"], #search';
          
          // First fill the search field
          await this.browserController.fillField(searchField, searchQuery, this.activeSession);
          
          // Then submit the search
          const submitSelector = aiCommand.submitSelector || 'input[type="submit"], button[type="submit"], button:has-text("Search")';
          return await this.browserController.clickElement(submitSelector, this.activeSession);
          
        case 'select':
          // Ensure both selector and option are provided
          if (!aiCommand.selector) {
            throw new Error('Select command missing required selector');
          }
          
          const selectOption = aiCommand.option || aiCommand.value || aiCommand.text;
          if (!selectOption) {
            throw new Error('Select command missing required option or value');
          }
          
          // Use executeScript to select the option
          return await this.browserController.executeScript(
            `const select = document.querySelector('${aiCommand.selector}');
             if (!select) throw new Error('Select element not found');
             
             // Try to find the option by value, text, or index
             const optionText = '${selectOption}';
             let found = false;
             
             // Try by value
             for (const option of select.options) {
               if (option.value === optionText || option.text === optionText) {
                 select.value = option.value;
                 found = true;
                 break;
               }
             }
             
             // If not found, try by text content
             if (!found) {
               for (const option of select.options) {
                 if (option.textContent.includes(optionText)) {
                   select.value = option.value;
                   found = true;
                   break;
                 }
               }
             }
             
             // Dispatch change event
             select.dispatchEvent(new Event('change', { bubbles: true }));
             return found;`,
            this.activeSession
          );
          
        case 'screenshot':
          return await this.browserController.takeScreenshot(this.activeSession);
          
        case 'wait':
          const waitTime = parseInt(aiCommand.time || aiCommand.duration || '2000', 10);
          
          // Wait using browser controller
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          return { success: true, message: `Waited for ${waitTime}ms` };
          
        case 'scroll':
          const direction = (aiCommand.direction || 'down').toLowerCase();
          const amount = parseInt(aiCommand.amount || '300', 10);
          
          // Use executeScript to scroll
          return await this.browserController.executeScript(
            `if ('${direction}' === 'up') {
               window.scrollBy(0, -${amount});
             } else if ('${direction}' === 'down') {
               window.scrollBy(0, ${amount});
             } else if ('${direction}' === 'left') {
               window.scrollBy(-${amount}, 0);
             } else if ('${direction}' === 'right') {
               window.scrollBy(${amount}, 0);
             }
             return true;`,
            this.activeSession
          );
          
        case 'back':
          // Go back in history
          return await this.browserController.executeScript(
            `window.history.back(); return true;`,
            this.activeSession
          );
          
        case 'forward':
          // Go forward in history
          return await this.browserController.executeScript(
            `window.history.forward(); return true;`,
            this.activeSession
          );
          
        case 'reload':
        case 'refresh':
          // Reload the page
          return await this.browserController.executeScript(
            `location.reload(); return true;`,
            this.activeSession
          );
          
        default:
          // Try to use traditional command processing as fallback
          return await this.executeCommand(aiCommand.originalCommand || action, this.activeSession);
      }
    } catch (error) {
      logger.error(`AI command execution error: ${error.message}`);
      
      // Attempt to recover with a more basic action if possible
      if (error.message.includes('missing required URL') && aiCommand.originalCommand) {
        // Try to extract a URL from the original command
        try {
          const extractedUrl = this.extractUrl(aiCommand.originalCommand);
          if (extractedUrl) {
            logger.info(`Recovered URL from original command: ${extractedUrl}`);
            return await this.browserController.navigateTo(extractedUrl, this.activeSession);
          }
        } catch (e) {
          // Ignore extraction errors
        }
      }
      
      // If we're here, we couldn't recover - throw the error
      throw new Error(`Command execution failed: ${error.message}`);
    }
  }

  /**
   * Determine the intent of a command
   * @param {string} command - Text command to analyze
   * @returns {object} Intent object with type and confidence
   */
  determineIntent(command) {
    let highestConfidence = 0;
    let detectedIntent = 'unknown';

    // Check each intent pattern
    for (const [intent, patterns] of Object.entries(this.commandPatterns)) {
      for (const pattern of patterns) {
        if (command.includes(pattern)) {
          // Calculate a better confidence score
          // Words that appear at the start of the command get more weight
          const wordPosition = command.indexOf(pattern) / command.length;
          const lengthScore = pattern.length / command.length;
          const confidence = lengthScore * (1 - wordPosition * 0.5);
          
          if (confidence > highestConfidence) {
            highestConfidence = confidence;
            detectedIntent = intent;
          }
        }
      }
    }

    // If we still haven't determined an intent but there's a URL in the command, 
    // assume it's a navigate command
    if (detectedIntent === 'unknown' && this.extractUrl(command)) {
      detectedIntent = 'navigate';
      highestConfidence = 0.5;
    }

    return {
      type: detectedIntent,
      confidence: highestConfidence
    };
  }

  /**
   * Tokenize a command string into an array of tokens
   * @param {string} command - Command string to tokenize
   * @returns {string[]} Array of tokens
   */
  tokenizeCommand(command) {
    if (!command || typeof command !== 'string') {
      return [];
    }
    return this.tokenizer.tokenize(command);
  }

  /**
   * Execute a command based on detected intent
   * @param {string} command - Text command to execute
   * @param {string} sessionId - Browser session ID
   * @returns {object} Command execution result
   */
  async executeCommand(command, sessionId) {
    try {
      // Handle commands
      const tokens = this.tokenizeCommand(command);
      const action = tokens.shift().toLowerCase();
      
      switch (action) {
        case 'navigate': 
        case 'goto': 
        case 'open':
          return await this.handleNavigateCommand(tokens, sessionId);
        
        case 'click':
          return await this.handleClickCommand(tokens, sessionId);
        
        case 'type': 
        case 'input': 
        case 'fill':
          return await this.handleInputCommand(tokens, sessionId);
          
        case 'screenshot':
          return await this.browserController.takeScreenshot(sessionId);
        
        case 'execute': 
        case 'script':
          return await this.handleScriptCommand(tokens, sessionId);
        
        case 'wait':
          return await this.handleWaitCommand(tokens, sessionId);
        
        case 'back':
          return await this.browserController.executeScript('window.history.back()', sessionId);
        
        case 'forward':
          return await this.browserController.executeScript('window.history.forward()', sessionId);
        
        case 'reload':
          return await this.browserController.executeScript('window.location.reload()', sessionId);
          
        case 'close':
          return await this.browserController.closeBrowser(sessionId);
          
        // New commands for enhanced element selection
        case 'inspect':
        case 'analyze':
          return await this.browserController.getPageStructure(sessionId);
          
        case 'find':
          return await this.handleFindCommand(tokens, sessionId);
          
        case 'extract':
        case 'scrape':
          return await this.handleExtractCommand(tokens, sessionId);
        
        // New drawing commands
        case 'draw':
          return await this.handleDrawCommand(tokens, sessionId);
        
        // New command to find by name or text
        case 'findbyname':
        case 'findbytext':
          return await this.handleFindByNameCommand(tokens, sessionId);
        
        default:
          throw new Error(`Unknown command: ${action}`);
      }
    } catch (error) {
      throw new Error(`Command execution failed: ${error.message}`);
    }
  }

  /**
   * Handle "open" commands
   * @param {string} command - Text command
   * @returns {object} Command execution result
   */
  async handleOpenCommand(command) {
    // Determine browser type
    let browserType = 'chromium'; // Default
    
    if (command.includes('firefox')) {
      browserType = 'firefox';
    } else if (command.includes('safari') || command.includes('webkit')) {
      browserType = 'webkit';
    } else if (command.includes('edge')) {
      browserType = 'edge';
    } else if (command.includes('chrome')) {
      browserType = 'chrome';
    }
    
    // Launch the browser
    const result = await this.browserController.launchBrowser(browserType);
    this.activeSession = result.sessionId;
    
    return {
      action: 'open',
      browserType,
      sessionId: result.sessionId,
      message: `Opened ${browserType} browser`
    };
  }

  /**
   * Handle "navigate" commands
   * @param {string} command - Text command
   * @param {object} options - Additional options from AI processing
   * @returns {object} Command execution result
   */
  async handleNavigateCommand(command, options = {}) {
    // Extract URL from command or use the one provided by AI
    let url = options.url || this.extractUrl(command);
    
    // If we couldn't find a URL, try to treat the command as a search query
    if (!url) {
      // Extract everything after "go to", "open", etc.
      const navigatePatterns = ['go to', 'navigate to', 'visit', 'open', 'browse', 'load'];
      for (const pattern of navigatePatterns) {
        if (command.includes(pattern)) {
          const afterPattern = command.substring(command.indexOf(pattern) + pattern.length).trim();
          if (afterPattern) {
            // If it seems like a domain (contains a dot and no spaces), try it as a URL
            if (afterPattern.includes('.') && !afterPattern.includes(' ')) {
              url = afterPattern;
            } else {
              // Otherwise, search Google for it
              return await this.handleSearchCommand(afterPattern);
            }
          }
        }
      }
    }
    
    // If we still don't have a URL, tell the user
    if (!url) {
      throw new Error('No URL found in command. Try "go to example.com" or "open https://example.com"');
    }
    
    // Ensure URL has protocol
    if (url && !url.startsWith('http')) {
      url = 'https://' + url;
    }
    
    // Check if we have an active session, create one if not
    if (!this.activeSession) {
      const session = await this.browserController.launchBrowser();
      this.activeSession = session.sessionId;
    }
    
    // Navigate to URL
    const result = await this.browserController.navigateTo(url, this.activeSession);
    
    return {
      action: 'navigate',
      url: result.url,
      title: result.title,
      message: `Navigated to ${result.url}`
    };
  }

  /**
   * Handle "click" commands with improved element finding
   * @param {string} command - Text command
   * @param {object} options - Additional options from AI processing
   * @returns {object} Command execution result
   */
  async handleClickCommand(command, options = {}) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Extract selector from command or use the one provided by AI
    let selector = options.selector;
    
    if (!selector) {
      // If target is provided, try to find by name/text first
      if (options.target) {
        const namedElements = await this.browserController.findElementsByNameOrText(options.target, this.activeSession);
        if (namedElements && namedElements.length > 0) {
          selector = namedElements[0].selector;
        } else {
          // Fall back to generating selector
          selector = this.generateSelectorFromTarget(options.target);
        }
      } else {
        // Extract selector from command
        selector = this.extractSelector(command);
      }
    }
    
    if (!selector) {
      throw new Error('Could not determine what to click. Please be more specific, e.g., "click the login button".');
    }
    
    // Click element
    await this.browserController.clickElement(selector, this.activeSession);
    
    return {
      action: 'click',
      selector,
      message: `Clicked element: ${selector}`
    };
  }

  /**
   * Generate a selector from a target description
   * @param {string} target - Target description
   * @returns {string} Generated selector
   */
  generateSelectorFromTarget(target) {
    // Generate selectors based on common patterns
    const buttonSelectors = [
      `button:has-text("${target}")`,
      `[role="button"]:has-text("${target}")`,
      `input[type="button"][value*="${target}" i]`,
      `.btn:has-text("${target}")`,
      `.button:has-text("${target}")`
    ].join(', ');
    
    const linkSelectors = [
      `a:has-text("${target}")`,
      `a[href*="${target}" i]`,
      `a[title*="${target}" i]`
    ].join(', ');
    
    // A general text match selector that works across different element types
    const textSelectors = [
      `text="${target}"`,
      `:has-text("${target}")`
    ].join(', ');
    
    if (target.includes('button') || target.includes('btn')) {
      return buttonSelectors;
    } else if (target.includes('link')) {
      return linkSelectors;
    } else {
      return `${buttonSelectors}, ${linkSelectors}, ${textSelectors}`;
    }
  }

  /**
   * Handle "type" commands with improved element finding
   * @param {string} command - Text command
   * @param {object} options - Additional options from AI processing
   * @returns {object} Command execution result
   */
  async handleTypeCommand(command, options = {}) {
    // Check if we have an active session
    if (!this.activeSession) {
      throw new Error('No active browser session. Try "open chrome" first.');
    }
    
    // Extract selector and text or use what AI provided
    let selector = options.selector;
    let text = options.text;
    
    if (!selector && options.target) {
      // Try to find by name/text first
      const namedElements = await this.browserController.findElementsByNameOrText(options.target, this.activeSession);
      if (namedElements && namedElements.length > 0) {
        selector = namedElements[0].selector;
      } else {
        // Fall back to extracting selector
        selector = this.extractSelectorFromTarget(options.target);
      }
    }
    
    // If we still don't have a selector, try traditional extraction
    if (!selector) {
      const extracted = this.extractSelectorAndText(command);
      selector = extracted.selector;
      if (!text) text = extracted.text;
    }
    
    if (!text) {
      throw new Error('No text found to type. Please specify what to type, e.g., "type hello in the search box".');
    }
    
    if (!selector) {
      throw new Error('No input field specified. Please specify where to type, e.g., "type hello in the search box".');
    }
    
    // Fill field
    await this.browserController.fillField(selector, text, this.activeSession);
    
    return {
      action: 'type',
      selector,
      text,
      message: `Typed "${text}" into ${selector}`
    };
  }

  /**
   * Extract a selector from a target description
   * @param {string} target - Target description
   * @returns {string} Extracted selector
   */
  extractSelectorFromTarget(target) {
    if (!target) return null;
    
    const targetLower = target.toLowerCase();
    
    if (targetLower.includes('email') || targetLower.includes('mail field')) {
      return 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    } else if (targetLower.includes('password')) {
      return 'input[type="password"]';
    } else if (targetLower.includes('search') || targetLower.includes('search box')) {
      return 'input[type="search"], input[name="q"], input[placeholder*="search" i], [aria-label*="search" i]';
    } else if (targetLower.includes('username') || targetLower.includes('user name')) {
      return 'input[name="username"], input[id="username"], input[placeholder*="username" i], input[name="user"]';
    } else if (targetLower.includes('text') || targetLower.includes('input') || targetLower.includes('field')) {
      return 'input:visible, textarea:visible';
    }
    
    return null;
  }

  /**
   * Extract selector and text from command
   * @param {string} command - Text command
   * @returns {object} Object with selector and text properties
   */
  extractSelectorAndText(command) {
    // Extract text to type - multiple patterns
    let text = null;
    
    // Pattern 1: "type 'text' in ..."
    let textMatch = command.match(/(?:type|enter|input|fill|write)\s+['"]([^'"]+)['"]\s+(?:in|into|to|on)/i);
    
    // Pattern 2: "... in the field with 'text'"
    if (!textMatch) {
      textMatch = command.match(/(?:in|into|to|on).*?(?:with|containing)\s+['"]([^'"]+)['"]$/i);
    }
    
    // Pattern 3: "type 'text'"
    if (!textMatch) {
      textMatch = command.match(/(?:type|enter|input|fill|write)\s+['"]([^'"]+)['"]$/i);
    }
    
    // Pattern 4: "... with 'text'"
    if (!textMatch) {
      textMatch = command.match(/(?:with|containing)\s+['"]([^'"]+)['"]$/i);
    }
    
    // Pattern 5: content after key words without quotes
    if (!textMatch) {
      textMatch = command.match(/(?:type|enter|input|fill|write)\s+(?!in|into|to|on)([^'"]+?)(?:\s+in|\s+into|\s+on|\s*$)/i);
    }
    
    if (textMatch) {
      text = textMatch[1].trim();
    }
    
    // Now extract selector - where to type the text
    let selector = null;
    
    // Look for mentions of specific form elements
    if (command.includes('email') || command.includes('email field') || command.includes('email box')) {
      selector = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    } else if (command.includes('password') || command.includes('password field')) {
      selector = 'input[type="password"]';
    } else if (command.includes('search') || command.includes('search box') || command.includes('search field')) {
      selector = 'input[type="search"], input[name="q"], input[placeholder*="search" i], [aria-label*="search" i]';
    } else if (command.includes('username') || command.includes('user name')) {
      selector = 'input[name="username"], input[id="username"], input[placeholder*="username" i], input[name="user"]';
    } else if (command.includes('comment') || command.includes('message')) {
      selector = 'textarea, .comment-box, [name="comment"]';
    } else if (command.includes('field') || command.includes('box') || command.includes('input')) {
      // Generic input field - less specific
      selector = 'input:visible, textarea:visible';
    }
    
    return { selector, text };
  }

  /**
   * Extract search query from command
   * @param {string} command - Text command
   * @returns {string|null} Extracted search query or null
   */
  extractSearchQuery(command) {
    // Pattern 1: "search for 'query'"
    let queryMatch = command.match(/(?:search|find|look for|query)(?:\s+for)?\s+['"]([^'"]+)['"]?/i);
    
    // Pattern 2: "search for query" (without quotes)
    if (!queryMatch) {
      queryMatch = command.match(/(?:search|find|look for|query)(?:\s+for)?\s+(.+)$/i);
    }
    
    return queryMatch ? queryMatch[1].trim() : null;
  }

  /**
   * Handle finding elements based on a description
   * @param {Array} tokens - Command tokens
   * @param {string} sessionId - Browser session ID
   * @returns {object} Found element details
   */
  async handleFindCommand(tokens, sessionId) {
    if (tokens.length === 0) {
      throw new Error('Find command requires an element description');
    }
    
    const description = tokens.join(' ');
    
    // First try to find elements by name or text content
    const namedElements = await this.browserController.findElementsByNameOrText(description, sessionId);
    
    // If we found elements by name/text, return the best match
    if (namedElements && namedElements.length > 0) {
      const bestMatch = namedElements[0];
      return {
        success: true,
        message: `Found element matching: ${description}`,
        element: bestMatch.element,
        selector: bestMatch.selector,
        score: bestMatch.score
      };
    }
    
    // Fall back to traditional element finding if name/text search didn't work
    const element = await this.browserController.findElement(description, sessionId);
    
    if (!element) {
      return { success: false, message: `No element found matching: ${description}` };
    }
    
    // Get detailed information about the element
    const elementDetails = await this.getElementDetails(element, sessionId);
    
    return {
      success: true,
      message: `Found element matching: ${description}`,
      element: elementDetails
    };
  }
  
  /**
   * Get detailed information about a DOM element
   * @param {object} element - Playwright element handle
   * @param {string} sessionId - Browser session ID
   * @returns {object} Element details
   */
  async getElementDetails(element, sessionId) {
    // Extract various properties of the element
    const tagName = await element.evaluate(el => el.tagName.toLowerCase());
    const textContent = await element.evaluate(el => el.textContent?.trim() || '');
    const isVisible = await element.isVisible();
    
    // Get element attributes
    const attributes = await element.evaluate(el => {
      const attrs = {};
      for (const attr of el.attributes) {
        attrs[attr.name] = attr.value;
      }
      return attrs;
    });
    
    // Get element position and dimensions
    const boundingBox = await element.boundingBox();
    
    // Get computed styles
    const styles = await element.evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        display: computed.display,
        position: computed.position,
        visibility: computed.visibility,
        zIndex: computed.zIndex
      };
    });
    
    // Generate a unique selector for this element
    const selector = await element.evaluate(el => {
      // Simple implementation - more robust one would be needed in production
      if (el.id) return `#${el.id}`;
      if (el.className) {
        const classes = Array.from(el.classList).join('.');
        return `.${classes}`;
      }
      
      // Fallback to a position-based selector
      let path = [];
      let currentEl = el;
      while (currentEl && currentEl.tagName !== 'HTML') {
        let selector = currentEl.tagName.toLowerCase();
        let sameTagSiblings = Array.from(currentEl.parentNode.children)
          .filter(e => e.tagName === currentEl.tagName);
        
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(currentEl) + 1;
          selector += `:nth-child(${index})`;
        }
        
        path.unshift(selector);
        currentEl = currentEl.parentNode;
      }
      
      return path.join(' > ');
    });
    
    return {
      tagName,
      selector,
      textContent,
      isVisible,
      attributes,
      boundingBox,
      styles
    };
  }
  
  /**
   * Handle extracting content from elements
   * @param {Array} tokens - Command tokens
   * @param {string} sessionId - Browser session ID
   * @returns {object} Extracted content
   */
  async handleExtractCommand(tokens, sessionId) {
    // If no specific selector provided, extract main content
    if (tokens.length === 0) {
      return await this.browserController.executeScript(`
        function extractMainContent() {
          // Remove navigation, headers, footers, ads, etc.
          const content = [];
          
          // Try to find the main content area
          const mainContent = document.querySelector('main') || 
                              document.querySelector('#content') ||
                              document.querySelector('.content') ||
                              document.querySelector('article') ||
                              document.body;
          
          // Get headings
          const headings = mainContent.querySelectorAll('h1, h2, h3');
          for (const heading of headings) {
            content.push({
              type: 'heading',
              level: parseInt(heading.tagName.substring(1)),
              text: heading.textContent.trim()
            });
          }
          
          // Get paragraphs
          const paragraphs = mainContent.querySelectorAll('p');
          for (const p of paragraphs) {
            content.push({
              type: 'paragraph',
              text: p.textContent.trim()
            });
          }
          
          // Get lists
          const lists = mainContent.querySelectorAll('ul, ol');
          for (const list of lists) {
            const items = Array.from(list.querySelectorAll('li'))
              .map(li => li.textContent.trim());
            
            content.push({
              type: list.tagName.toLowerCase() === 'ul' ? 'unordered_list' : 'ordered_list',
              items
            });
          }
          
          // Get tables
          const tables = mainContent.querySelectorAll('table');
          for (const table of tables) {
            const headers = Array.from(table.querySelectorAll('th'))
              .map(th => th.textContent.trim());
            
            const rows = [];
            for (const row of table.querySelectorAll('tr')) {
              const cells = Array.from(row.querySelectorAll('td'))
                .map(td => td.textContent.trim());
              
              if (cells.length > 0) {
                rows.push(cells);
              }
            }
            
            content.push({
              type: 'table',
              headers,
              rows
            });
          }
          
          return content;
        }
        
        return extractMainContent();
      `, sessionId);
    }
    
    // Extract from specific elements
    const description = tokens.join(' ');
    const element = await this.browserController.findElement(description, sessionId);
    
    if (!element) {
      return { 
        success: false, 
        message: `No element found matching: ${description}` 
      };
    }
    
    // Extract based on element type
    const elementDetails = await this.getElementDetails(element, sessionId);
    const tagName = elementDetails.tagName;
    
    if (tagName === 'table') {
      // Extract table data
      return await element.evaluate(table => {
        const headers = Array.from(table.querySelectorAll('th'))
          .map(th => th.textContent.trim());
        
        const rows = [];
        for (const row of table.querySelectorAll('tr')) {
          const cells = Array.from(row.querySelectorAll('td'))
            .map(td => td.textContent.trim());
          
          if (cells.length > 0) {
            rows.push(cells);
          }
        }
        
        return {
          type: 'table',
          headers,
          rows
        };
      });
    } else if (tagName === 'ul' || tagName === 'ol') {
      // Extract list items
      return await element.evaluate(list => {
        const items = Array.from(list.querySelectorAll('li'))
          .map(li => li.textContent.trim());
        
        return {
          type: list.tagName.toLowerCase() === 'ul' ? 'unordered_list' : 'ordered_list',
          items
        };
      });
    } else {
      // Default extraction
      return {
        type: 'text',
        content: elementDetails.textContent,
        html: await element.evaluate(el => el.innerHTML)
      };
    }
  }

  /**
   * Handle finding elements by name or text content
   * @param {Array} tokens - Command tokens
   * @param {string} sessionId - Browser session ID
   * @returns {object} Found elements
   */
  async handleFindByNameCommand(tokens, sessionId) {
    if (tokens.length === 0) {
      throw new Error('Find by name command requires a name or text to search for');
    }
    
    const nameOrText = tokens.join(' ');
    
    // Find elements by name or text
    const results = await this.browserController.findElementsByNameOrText(nameOrText, sessionId);
    
    if (results.length === 0) {
      return {
        success: false,
        message: `No elements found with name or text matching: ${nameOrText}`
      };
    }
    
    // Return the top 5 results (or fewer if there aren't that many)
    const topResults = results.slice(0, 5);
    
    return {
      success: true,
      message: `Found ${results.length} elements matching: ${nameOrText}`,
      results: topResults.map(item => ({
        selector: item.selector,
        score: item.score,
        element: {
          tag: item.element.tag,
          id: item.element.id,
          name: item.element.name,
          text: item.element.textContent,
          type: item.element.type
        }
      }))
    };
  }

  /**
   * Handle draw commands for canvas elements
   * @param {Array} tokens - Command tokens
   * @param {string} sessionId - Browser session ID
   * @returns {object} Draw result
   */
  async handleDrawCommand(tokens, sessionId) {
    if (tokens.length === 0) {
      throw new Error('Draw command requires parameters');
    }
    
    // Parse draw command parameters
    let canvasSelector = 'canvas';  // Default selector
    let drawingType = 'freestyle';
    let color = '#000000';
    let points = [];
    
    // Extract parameters from tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      
      if (token === 'on' && i < tokens.length - 1) {
        // Extract canvas selector
        canvasSelector = tokens[i + 1];
        i++; // Skip the next token
      } else if (token === 'circle' || token === 'square' || token === 'line') {
        drawingType = token;
      } else if (token === 'color' && i < tokens.length - 1) {
        color = tokens[i + 1];
        i++; // Skip the next token
      }
    }
    
    // Get canvas dimensions from the page
    const session = this.browserController.getSession(sessionId);
    const canvasInfo = await session.page.evaluate((selector) => {
      const canvas = document.querySelector(selector);
      if (!canvas) return null;
      
      const rect = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        left: rect.left,
        top: rect.top
      };
    }, canvasSelector);
    
    if (!canvasInfo) {
      throw new Error(`Canvas not found with selector: ${canvasSelector}`);
    }
    
    // Generate points based on the drawing type
    if (drawingType === 'circle') {
      // Draw a circle in the center
      const centerX = canvasInfo.width / 2;
      const centerY = canvasInfo.height / 2;
      const radius = Math.min(canvasInfo.width, canvasInfo.height) / 4;
      
      for (let i = 0; i <= 360; i += 10) {
        const radian = (i * Math.PI) / 180;
        const x = centerX + radius * Math.cos(radian);
        const y = centerY + radius * Math.sin(radian);
        points.push({ x, y });
      }
    } else if (drawingType === 'square') {
      // Draw a square
      const size = Math.min(canvasInfo.width, canvasInfo.height) / 2;
      const left = (canvasInfo.width - size) / 2;
      const top = (canvasInfo.height - size) / 2;
      
      points = [
        { x: left, y: top },
        { x: left + size, y: top },
        { x: left + size, y: top + size },
        { x: left, y: top + size },
        { x: left, y: top }
      ];
    } else if (drawingType === 'line') {
      // Draw a diagonal line
      points = [
        { x: 0, y: 0 },
        { x: canvasInfo.width, y: canvasInfo.height }
      ];
    } else {
      // Freestyle - generate a wavy line across the canvas
      for (let x = 0; x < canvasInfo.width; x += 10) {
        const y = canvasInfo.height / 2 + Math.sin(x / 20) * 30;
        points.push({ x, y });
      }
    }
    
    // Draw on the canvas
    const drawOptions = { color, lineWidth: 3 };
    await this.browserController.drawOnCanvas(canvasSelector, points, drawOptions, sessionId);
    
    return {
      success: true,
      message: `Drew ${drawingType} on canvas`,
      canvasSelector,
      drawingType,
      color
    };
  }
}

module.exports = CommandParser;