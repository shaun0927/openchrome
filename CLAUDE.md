# Claude Code Project Instructions

## Browser Tool Usage Guidelines

This project provides browser automation tools (chrome-parallel). Use them appropriately.

### Tool Selection Priority

1. **Code Analysis** - Read and understand relevant code first
2. **Direct DB Operations** - For data issues, use database queries
3. **API Testing** - For API issues, use curl to test directly
4. **Browser Automation** - Only when above methods are not possible AND UI interaction is required

### When to Use Browser Tools

Use chrome-parallel browser tools ONLY when:
- User explicitly mentions "browser", "site", "page", "screenshot"
- Visual verification or screenshot is needed
- UI interaction is required (login flow testing, form submission, etc.)
- No API/DB alternative exists for the task

### When NOT to Use Browser Tools

| Problem Type | Wrong Approach | Correct Approach |
|--------------|----------------|------------------|
| Data lookup/modification | Navigate to admin panel | DB query directly |
| API response verification | Open browser to check | `curl` command |
| Code bug fixing | Debug via browser | Modify code directly |
| Configuration changes | Use settings UI | Edit config files |

### Cost Awareness

| Approach | Time | Reliability | Context Usage |
|----------|------|-------------|---------------|
| DB Query | ~1s | High | Low |
| API Call | ~2s | High | Low |
| Code Fix | ~5s | High | Low |
| Browser  | ~30s+ | Medium | High |

Browser automation is powerful but should be your **LAST resort**, not your first choice.

### Decision Flowchart

```
User Request
    |
    v
Is it about data? --YES--> Use DB query
    |NO
    v
Is it about API? --YES--> Use curl/API client
    |NO
    v
Is it about code? --YES--> Read/fix code directly
    |NO
    v
Did user explicitly --NO--> Ask for clarification
mention browser/UI?
    |YES
    v
Use browser tools
```
