param(
    [string]$BaseUrl = "https://api.openai.com/v1",
    [string]$Model = "gpt-image-2",
    [string]$ResponsesModel = "gpt-5.6",
    [ValidateSet("auto", "images", "responses")]
    [string]$ApiMode = "auto",
    [string]$UserAgent = "",
    [switch]$Clear
)

$names = @("GPT_IMAGE_API_KEY", "GPT_IMAGE_BASE_URL", "GPT_IMAGE_MODEL", "GPT_IMAGE_RESPONSES_MODEL", "GPT_IMAGE_API_MODE", "GPT_IMAGE_USER_AGENT")

if ($Clear) {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $null, "User")
    }
    Write-Host "GPT Image MCP user credentials were cleared. Restart Codex."
    exit 0
}

$secureKey = Read-Host "Enter the image API key (input is hidden)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw "API key cannot be empty."
    }
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_API_KEY", $apiKey, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_BASE_URL", $BaseUrl.TrimEnd('/'), "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_MODEL", $Model, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_RESPONSES_MODEL", $ResponsesModel, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_API_MODE", $ApiMode, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_USER_AGENT", $(if ($UserAgent) { $UserAgent } else { $null }), "User")
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $apiKey = $null
}

Write-Host "GPT Image MCP configuration saved to the current Windows user environment."
Write-Host "Base URL: $($BaseUrl.TrimEnd('/'))"
Write-Host "Model: $Model"
Write-Host "Responses model: $ResponsesModel"
Write-Host "API mode: $ApiMode"
Write-Host "User agent: $(if ($UserAgent) { $UserAgent } else { 'OpenAI SDK default' })"
Write-Host "Fully exit Codex from the system tray, restart it, and open a new task."
