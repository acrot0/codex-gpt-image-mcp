# Security

Report vulnerabilities privately through GitHub Security Advisories. Do not include live API keys, generated private images, or provider credentials in an issue.

The server reads credentials from environment variables. It never accepts an API key as an MCP tool argument. Generated files and local image inputs are restricted to the user's home directory and explicitly allowed roots.
