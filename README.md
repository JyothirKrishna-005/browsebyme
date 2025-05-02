# BrowseByMe

An AI-powered browser automation tool that lets you control browsers using natural language commands.

## Features

- Control web browsers with simple text commands
- AI-powered command interpretation (with Gemini API)
- Handles navigation, clicking, form filling, searching, and more
- Works with Chrome/Chromium, Firefox, and Safari/WebKit
- Screenshot capture capabilities
- Multi-browser session support

## Installation

1. Make sure you have Node.js installed (v14 or higher)
2. Clone this repository
3. Install dependencies:

```bash
npm install
```

4. (Optional) Set up Gemini API for enhanced AI capabilities:
   - Create a Google Cloud Platform account if you don't have one
   - Enable the Gemini API and get an API key
   - Create a `.env` file in the project root and add:
     ```
     GEMINI_API_KEY=your_api_key_here
     ```

## Usage

1. Start the server:

```bash
npm start
```

2. The server will start on port 3000 (or the port specified in your .env file)
3. Use the web interface at http://localhost:3000 to enter commands

### Example Commands

BrowseByMe understands natural language commands like:

- "Open Chrome and go to google.com"
- "Search for AI browser automation"
- "Click the first result"
- "Type hello world in the search box"
- "Click the login button"
- "Go to amazon.com and search for headphones"
- "Take a screenshot"
- "Scroll down"

### Advanced Usage

The system automatically interprets your commands and performs the appropriate actions. For complex tasks that involve multiple steps, it will break them down and execute them in sequence.

## Troubleshooting

### Common Issues

1. **Browser doesn't start**: Make sure you have the browser installed on your system. Chrome/Chromium is recommended for best compatibility.

2. **Can't click elements**: The system might not be able to find the element you're referring to. Try being more specific in your command, like "click the blue signup button" instead of just "click signup".

3. **Form filling issues**: For filling out forms, be explicit about which field you want to interact with, like "type johndoe@example.com in the email field".

4. **jQuery selector errors**: If you see errors related to selectors like `:visible`, these have been fixed in the latest version. Update to the latest version or manually avoid jQuery-style selectors.

### Debugging

You can check the logs in the console to see what's happening behind the scenes. If you're having issues with a particular website, try using more specific commands or breaking down your task into smaller steps.

## Configuration

The config file at `src/config/config.js` allows you to customize various aspects of the system, including default browser settings and timeout values.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. 