# Contributing to Browser Control MCP

We welcome pull requests for adding new features and tools to the extension, as well as for bug fixes.

## Development Guidelines

### Testing Requirements
- Make sure to update the Firefox extension unit tests when making changes
- Test the MCP server integration with Claude Desktop
- Test the Firefox extension on Firefox Developer Edition

### Compatibility
- Keep backwards and forward compatibility in mind when making changes
- Ensure changes work across different versions of Firefox and Claude Desktop

### Security and Privacy
Security and privacy are the core design principles of this solution. Please ensure that:
- All browser interactions require explicit user consent
- No sensitive data is logged or transmitted unnecessarily  
- Extension permissions are minimal and justified
- WebSocket communication uses proper authentication

## Getting Started

See the main README.md for setup instructions and the CLAUDE.md file for development commands.

## Pull Request Process

1. Fork the repository
2. Create a feature branch
3. Make your changes with appropriate tests
4. Run the test suite: `cd firefox-extension && npm test`
5. Build all projects: `npm run build`
6. Test manually with Claude Desktop and Firefox Developer Edition
7. Submit a pull request with a clear description of changes