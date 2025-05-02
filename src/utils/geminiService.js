/**
 * Gemini AI Service
 * Integrates with Google's Gemini API for AI-powered browser control
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logger } = require('./logger');
const fs = require('fs').promises;
const path = require('path');

class GeminiService {
  constructor(apiKey) {
    // Initialize Gemini API client
    this.apiKey = apiKey;
    
    if (!this.apiKey) {
      logger.warn('No Gemini API key provided. AI features will be disabled.');
    } else {
      this.genAI = new GoogleGenerativeAI(this.apiKey);
      logger.info('Gemini AI service initialized');
    }
    
    // Store conversation history for context
    this.history = [];
    
    // Load system instructions
    this.loadSystemInstructions();
  }
  
  /**
   * Load system instructions for the AI model
   */
  async loadSystemInstructions() {
    try {
      const instructionsPath = path.join(__dirname, '../config/ai-instructions.txt');
      this.systemInstructions = await fs.readFile(instructionsPath, 'utf-8');
      logger.info('Loaded AI system instructions');
    } catch (error) {
      this.systemInstructions = 
        "You are BrowseByMe AI, a browser automation assistant. " +
        "Your task is to understand user commands about web browsing and convert them to specific " +
        "structured actions the system can perform. Focus on tasks like navigation, clicking, form filling, " +
        "and searching. Be specific and precise in your instructions.";
      
      logger.warn(`Failed to load AI instructions: ${error.message}. Using default instructions.`);
    }
  }
  
  /**
   * Process a user command with Gemini AI
   * @param {string} userCommand - User's text command
   * @param {object} currentState - Current browser state
   * @returns {object} Structured command object
   */
  async processCommand(userCommand, currentState = {}) {
    // If no API key, return a simple fallback processing
    if (!this.apiKey || !this.genAI) {
      logger.warn('No Gemini API key - using fallback command processing');
      return this.fallbackProcessCommand(userCommand);
    }

    try {
      // Update conversation history
      this.addToHistory("user", userCommand);
      
      // Prepare context about the current browser state
      const stateInfo = this.formatStateInfo(currentState);
      
      // Create the model
      const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
      
      // Create chat session
      const chat = model.startChat({
        history: this.prepareChatHistory(),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1500,
        }
      });
      
      // Format prompt with context and example of DOM structure if available
      const domInfo = currentState.domSnapshot ? 
        `\nCurrent page DOM structure (partial):\n${currentState.domSnapshot}` : '';
      
      const prompt = `
        ${this.systemInstructions}
        
        Current browser state:
        ${stateInfo}
        ${domInfo}
        
        Analyze the following user request: "${userCommand}"
        
        1. Identify the primary task the user wants to accomplish
        2. Determine the sequence of actions needed
        3. For each action, provide all necessary details (selectors, values, etc.)
        4. Remember to use only standard CSS selectors, not jQuery-style selectors
        
        Respond with a structured JSON action plan that can be executed by the system.
        The response should be a single action object or an array of action objects if multiple steps are needed.
        Each action object should include appropriate fields like "action", "selector", "value", etc.
        
        You MUST return ONLY valid, well-formed JSON without any formatting issues, trailing commas, or syntax errors.
        Here are examples of valid response formats:
        
        Single action: {"action": "navigate", "url": "https://example.com"}
        Multiple actions: [{"action": "navigate", "url": "https://example.com"}, {"action": "click", "selector": "button.search"}]
        
        Double-check your JSON syntax before responding!
      `;
      
      // Send to model
      const result = await chat.sendMessage(prompt);
      const responseText = result.response.text();
      
      // Try multiple JSON extraction and repair strategies
      let parsedResult = this.extractAndRepairJSON(responseText, userCommand);
      
      if (parsedResult) {
        // Clean up any invalid selectors in the result
        parsedResult = this.sanitizeSelectors(parsedResult);
          
        // Add to history
        this.addToHistory("assistant", JSON.stringify(parsedResult));
          
        return parsedResult;
      }
      
      // If all JSON extraction attempts failed, use fallback
      logger.warn(`AI response could not be parsed as valid JSON: ${responseText.substring(0, 100)}...`);
      return this.fallbackProcessCommand(userCommand);
      
    } catch (error) {
      logger.error(`Gemini AI error: ${error.message}`);
      return this.fallbackProcessCommand(userCommand);
    }
  }
  
  /**
   * Extract and repair JSON from AI response text
   * @param {string} responseText - Raw text from AI response
   * @param {string} userCommand - Original user command for fallback
   * @returns {object|array|null} Parsed JSON or null if parsing failed
   */
  extractAndRepairJSON(responseText, userCommand) {
    // Strategy 1: Direct parse of the whole response
    try {
      const directParse = JSON.parse(responseText.trim());
      logger.info(`Successfully parsed AI response as JSON directly`);
      return directParse;
    } catch (error) {
      logger.debug(`Direct JSON parse failed: ${error.message}`);
    }
    
    // Strategy 2: Extract JSON using regex pattern matching
    try {
      const jsonMatch = responseText.match(/(\[|\{)[\s\S]*(\]|\})/);
      if (jsonMatch) {
        const extractedJson = jsonMatch[0];
        const parsedResult = JSON.parse(extractedJson);
        logger.info(`Successfully extracted and parsed JSON using regex`);
        return parsedResult;
      }
    } catch (error) {
      logger.debug(`JSON extraction and parsing failed: ${error.message}`);
    }
    
    // Strategy 3: Attempt to repair common JSON syntax issues
    try {
      // Try to fix common issues like trailing commas
      const fixedJson = this.repairMalformedJSON(responseText);
      if (fixedJson) {
        const parsedResult = JSON.parse(fixedJson);
        logger.info(`Successfully parsed AI response after JSON repair`);
        return parsedResult;
      }
    } catch (error) {
      logger.debug(`JSON repair failed: ${error.message}`);
    }
    
    // Strategy 4: Look for valid JSON objects/arrays line by line
    try {
      const lines = responseText.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        if ((trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) || 
            (trimmedLine.startsWith('[') && trimmedLine.endsWith(']'))) {
          try {
            const parsedLine = JSON.parse(trimmedLine);
            logger.info(`Found valid JSON on a single line`);
            return parsedLine;
          } catch (e) {
            // Continue to next line
          }
        }
      }
    } catch (error) {
      logger.debug(`Line-by-line JSON parsing failed: ${error.message}`);
    }
    
    // Strategy 5: Extract and construct a basic action object from the text
    try {
      // Try to at least extract action type and target/selector/url
      const actionMatch = responseText.match(/"action"\s*:\s*"([^"]+)"/);
      
      if (actionMatch) {
        const action = actionMatch[1];
        const basicResult = { action };
        
        // Look for URL if it's a navigation action
        if (action === 'navigate' || action === 'go') {
          const urlMatch = responseText.match(/"url"\s*:\s*"([^"]+)"/);
          if (urlMatch) {
            basicResult.url = urlMatch[1];
          } else {
            // Attempt to extract a URL from the response or command
            const extractedUrl = this.extractUrlFromText(responseText) || 
                               this.extractUrlFromText(userCommand);
            if (extractedUrl) {
              basicResult.url = extractedUrl;
            } else {
              // If no URL found, default to a search
              basicResult.url = "https://www.google.com";
            }
          }
        }
        
        // Look for selector/target if it's a click action
        if (action === 'click') {
          const selectorMatch = responseText.match(/"(?:selector|target)"\s*:\s*"([^"]+)"/);
          if (selectorMatch) {
            basicResult.selector = selectorMatch[1];
          } else {
            // Default to a generic selector
            basicResult.selector = "button, a, [role='button']";
          }
        }
        
        // Look for input value and field if it's a type action
        if (action === 'type' || action === 'fill' || action === 'input') {
          const valueMatch = responseText.match(/"(?:value|text)"\s*:\s*"([^"]+)"/);
          const selectorMatch = responseText.match(/"(?:selector|field|target)"\s*:\s*"([^"]+)"/);
          
          if (valueMatch) {
            basicResult.value = valueMatch[1];
          }
          
          if (selectorMatch) {
            basicResult.selector = selectorMatch[1];
          } else {
            // Default to input fields
            basicResult.selector = "input, textarea";
          }
        }
        
        logger.info(`Constructed basic action object from response text`);
        return basicResult;
      }
    } catch (error) {
      logger.debug(`Basic action extraction failed: ${error.message}`);
    }
    
    // All extraction strategies failed
    return null;
  }
  
  /**
   * Attempt to repair common JSON syntax issues
   * @param {string} malformedJson - JSON string with potential syntax issues
   * @returns {string|null} Repaired JSON string or null if repair failed
   */
  repairMalformedJSON(malformedJson) {
    try {
      // Remove markdown code block markers if present
      let json = malformedJson.replace(/```json|```/g, '').trim();
      
      // Remove any text before the first { or [ and after the last } or ]
      const startIndex = Math.min(
        json.indexOf('{') >= 0 ? json.indexOf('{') : Infinity,
        json.indexOf('[') >= 0 ? json.indexOf('[') : Infinity
      );
      
      const endIndex = Math.max(
        json.lastIndexOf('}') >= 0 ? json.lastIndexOf('}') + 1 : -Infinity,
        json.lastIndexOf(']') >= 0 ? json.lastIndexOf(']') + 1 : -Infinity
      );
      
      if (startIndex < Infinity && endIndex > 0) {
        json = json.substring(startIndex, endIndex);
      }
      
      // Fix trailing commas in arrays and objects
      json = json.replace(/,\s*]/g, ']');
      json = json.replace(/,\s*}/g, '}');
      
      // Fix missing quotes around property names
      json = json.replace(/([{,]\s*)([a-zA-Z0-9_$]+)(\s*:)/g, '$1"$2"$3');
      
      // Fix single quotes used instead of double quotes
      json = json.replace(/'/g, '"');
      
      // Handle escaped quotes inside already quoted strings
      // This is a simplified approach and might not catch all cases
      let inString = false;
      let result = '';
      for (let i = 0; i < json.length; i++) {
        const char = json[i];
        if (char === '"' && (i === 0 || json[i-1] !== '\\')) {
          inString = !inString;
        }
        
        if (char === "'" && !inString) {
          result += '"';
        } else {
          result += char;
        }
      }
      
      // Try to parse it to verify it's now valid
      JSON.parse(result);
      return result;
      
    } catch (error) {
      logger.debug(`JSON repair attempt failed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Extract a URL from text using regex
   * @param {string} text - Text to extract URL from
   * @returns {string|null} Extracted URL or null if none found
   */
  extractUrlFromText(text) {
    try {
      // Look for URLs in the text
      const urlRegex = /(https?:\/\/[^\s"',]+)/i;
      const match = text.match(urlRegex);
      if (match) {
        return match[1];
      }
      
      // Look for domain names and add https://
      const domainRegex = /\b([a-z0-9][-a-z0-9]*\.)+[a-z]{2,}\b/i;
      const domainMatch = text.match(domainRegex);
      if (domainMatch) {
        return `https://${domainMatch[0]}`;
      }
    } catch (error) {
      // Ignore extraction errors
    }
    return null;
  }
  
  /**
   * Sanitize selectors to ensure they're valid CSS selectors
   * @param {object|array} result - The parsed result from AI
   * @returns {object|array} Sanitized result
   */
  sanitizeSelectors(result) {
    // Handle array of actions
    if (Array.isArray(result)) {
      return result.map(action => this.sanitizeSelectors(action));
    }
    
    // Handle single action object
    if (result && typeof result === 'object') {
      // If there's a selector field, sanitize it
      if (result.selector) {
        // Remove jQuery-style selectors
        result.selector = result.selector
          .replace(/:visible/g, '')
          .replace(/:contains\((.*?)\)/g, ':has-text($1)')
          .replace(/:eq\(\d+\)/g, '')
          .trim();
        
        // If selector became empty or too simple, provide a fallback
        if (!result.selector || result.selector === '') {
          if (result.action === 'click') {
            result.selector = 'button, a, [role="button"]';
          } else if (result.action === 'type') {
            result.selector = 'input, textarea';
          }
        }
      }
      
      // For navigate actions, ensure the URL is properly formatted
      if ((result.action === 'navigate' || result.action === 'go') && result.url) {
        // Add https:// if no protocol specified
        if (!result.url.match(/^https?:\/\//)) {
          result.url = 'https://' + result.url;
        }
      }
      
      // For click actions without a selector but with a target, use the target as selector
      if (result.action === 'click' && !result.selector && result.target) {
        // Convert target to selector
        result.selector = result.target;
        // Keep target for reference
      }
      
      // Recursively process nested objects
      for (const key in result) {
        if (typeof result[key] === 'object' && result[key] !== null) {
          result[key] = this.sanitizeSelectors(result[key]);
        }
      }
    }
    
    return result;
  }
  
  /**
   * Format the current browser state info
   * @param {object} state - Current state object
   * @returns {string} Formatted state info
   */
  formatStateInfo(state) {
    if (!state || Object.keys(state).length === 0) {
      return "No active browser session.";
    }
    
    let info = [];
    
    if (state.url) {
      info.push(`Current URL: ${state.url}`);
    }
    
    if (state.title) {
      info.push(`Page title: ${state.title}`);
    }
    
    if (state.activeSessionId) {
      info.push(`Active session ID: ${state.activeSessionId}`);
    }
    
    if (state.browserType) {
      info.push(`Browser type: ${state.browserType}`);
    }
    
    if (state.visibleElements) {
      info.push(`Notable page elements: ${state.visibleElements.join(', ')}`);
    }
    
    return info.join('\n');
  }
  
  /**
   * Fallback command processing without AI
   * @param {string} command - User command
   * @returns {object} Simple structured command
   */
  fallbackProcessCommand(command) {
    const normalizedCommand = command.toLowerCase();
    
    // Very simple rule-based parsing
    if (normalizedCommand.includes('go to') || normalizedCommand.includes('navigate')) {
      const urlMatch = normalizedCommand.match(/(?:go to|navigate to|open)\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (urlMatch) {
        return {
          action: 'navigate',
          url: urlMatch[1]
        };
      }
    }
    
    if (normalizedCommand.includes('click')) {
      const clickMatch = normalizedCommand.match(/click\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+link|$)/i);
      if (clickMatch) {
        return {
          action: 'click',
          target: clickMatch[1].trim()
        };
      }
    }
    
    if (normalizedCommand.includes('type') || normalizedCommand.includes('enter') || normalizedCommand.includes('input')) {
      const typeMatch = normalizedCommand.match(/(?:type|enter|input)\s+["'](.+?)["']/i);
      if (typeMatch) {
        return {
          action: 'type',
          value: typeMatch[1],
          target: 'input field'
        };
      }
    }
    
    if (normalizedCommand.includes('search')) {
      const searchMatch = normalizedCommand.match(/search\s+(?:for\s+)?(.+)$/i);
      if (searchMatch) {
        return {
          action: 'search',
          value: searchMatch[1].trim()
        };
      }
    }
    
    // Default to treating the command as-is
    return {
      action: 'unknown',
      originalCommand: command
    };
  }
  
  /**
   * Add a message to the conversation history
   * @param {string} role - "user" or "assistant"
   * @param {string} content - Message content
   */
  addToHistory(role, content) {
    this.history.push({ role, content });
    
    // Keep history at a reasonable size
    if (this.history.length > 20) {
      this.history.shift();
    }
  }
  
  /**
   * Prepare chat history in the format expected by Gemini
   * @returns {Array} Formatted chat history
   */
  prepareChatHistory() {
    return this.history.map(entry => ({
      role: entry.role,
      parts: [{ text: entry.content }]
    }));
  }
  
  /**
   * Clear the conversation history
   */
  clearHistory() {
    this.history = [];
  }
}

module.exports = GeminiService; 