/**
 * Usage Guide Resource - Provides guidance on when to use browser automation
 */

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const usageGuideResource: MCPResourceDefinition = {
  uri: 'chrome-parallel://usage-guide',
  name: 'browser-usage-guide',
  description: 'Guidelines on when to use browser automation vs alternatives',
  mimeType: 'text/plain',
};

export const usageGuideContent = `
# Browser Automation Usage Guide

## When to Use Browser Tools

Use chrome-parallel browser tools ONLY when:

1. **User explicitly requests browser/UI interaction**
   - Keywords: "browser", "site", "page", "screenshot", "click", "UI"
   - Example: "Take a screenshot of the login page"

2. **Visual verification is required**
   - Checking how a page looks
   - Verifying UI elements are displayed correctly
   - Taking screenshots for documentation

3. **No programmatic alternative exists**
   - The website has no API
   - The action requires JavaScript execution
   - Authentication flows that can't be bypassed

4. **Real user interaction simulation is needed**
   - Form filling with dynamic validation
   - Multi-step workflows with JS-heavy pages
   - Testing actual user experience

## When to PREFER Alternatives

### Data Issues → Use Database Directly
- Problem: "User's data is wrong in the system"
- BAD: Navigate to admin panel → Find user → Edit form → Submit
- GOOD: Direct SQL/DB query to fix the data

### API Issues → Use curl/fetch/API client
- Problem: "API returns wrong response"
- BAD: Open browser → Navigate to endpoint → Check response
- GOOD: \`curl -X GET https://api.example.com/endpoint\`

### Code Bugs → Analyze and Fix Code
- Problem: "Button click doesn't work"
- BAD: Open browser → Try clicking → Debug visually
- GOOD: Read the code → Find the bug → Fix it directly

### Configuration Issues → Edit Config Files
- Problem: "Wrong setting in the application"
- BAD: Navigate to settings page → Change UI value
- GOOD: Edit the configuration file directly

## Decision Flowchart

\`\`\`
User Request
    │
    ▼
Is it about data? ──YES──► Use DB query
    │NO
    ▼
Is it about API? ──YES──► Use curl/API client
    │NO
    ▼
Is it about code? ──YES──► Read/fix code directly
    │NO
    ▼
Did user explicitly ──NO──► Ask for clarification
mention browser/UI?
    │YES
    ▼
Use browser tools
\`\`\`

## Cost Comparison

| Approach | Time | Reliability | Context Usage |
|----------|------|-------------|---------------|
| DB Query | ~1s | High | Low |
| API Call | ~2s | High | Low |
| Code Fix | ~5s | High | Low |
| Browser Automation | ~30s+ | Medium | High |

## Summary

Browser automation is a powerful tool, but it should be your LAST resort.
Always consider simpler, faster, more reliable alternatives first.
`;

export function getUsageGuideContent(): string {
  return usageGuideContent.trim();
}
