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

$baseUrlValue = if ($null -eq $BaseUrl) { "" } else { $BaseUrl.Trim() }
if ([string]::IsNullOrWhiteSpace($baseUrlValue) -or
    $baseUrlValue -match "[\x00-\x20\x7F]") {
    throw "Base URL must be a non-empty URL without whitespace or control characters."
}
$baseUri = $null
if (-not [Uri]::TryCreate($baseUrlValue, [UriKind]::Absolute, [ref]$baseUri)) {
    throw "Base URL must be an absolute HTTP(S) URL without credentials, query, or fragment."
}
if ($baseUri.Scheme -notin @("http", "https") -or
    [string]::IsNullOrWhiteSpace($baseUri.Host) -or
    $baseUri.UserInfo -or $baseUri.Query -or $baseUri.Fragment) {
    throw "Base URL must be an absolute HTTP(S) URL without credentials, query, or fragment."
}
$baseUrlValue = $baseUrlValue.TrimEnd("/")

function Normalize-ModelName([string]$value, [string]$label) {
    $normalized = if ($null -eq $value) { "" } else { $value.Trim() }
    if ([string]::IsNullOrWhiteSpace($normalized) -or
        $normalized -match "[\x00-\x20\x7F]") {
        throw "$label must be non-empty and contain no whitespace or control characters."
    }
    return $normalized
}

$modelValue = Normalize-ModelName $Model "Model"
$responsesModelValue = Normalize-ModelName $ResponsesModel "Responses model"
$userAgentValue = if ($null -eq $UserAgent) { "" } else { $UserAgent.Trim() }
if ($userAgentValue -match "[\x00-\x1F\x7F]") {
    throw "User agent must not contain control characters."
}
if ($userAgentValue.Length -gt 512) {
    throw "User agent must be 512 characters or fewer."
}

$secureKey = Read-Host "Enter the image API key (input is hidden)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($apiKey) -or
        $apiKey -match "[\x00-\x1F\x7F]") {
        throw "API key must be non-empty and contain no control characters."
    }
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_API_KEY", $apiKey, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_BASE_URL", $baseUrlValue, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_MODEL", $modelValue, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_RESPONSES_MODEL", $responsesModelValue, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_API_MODE", $ApiMode, "User")
    [Environment]::SetEnvironmentVariable("GPT_IMAGE_USER_AGENT", $(if ($userAgentValue) { $userAgentValue } else { $null }), "User")
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $apiKey = $null
}

Write-Host "GPT Image MCP configuration saved to the current Windows user environment."
Write-Host "Base URL: $baseUrlValue"
Write-Host "Model: $modelValue"
Write-Host "Responses model: $responsesModelValue"
Write-Host "API mode: $ApiMode"
Write-Host "User agent: $(if ($userAgentValue) { $userAgentValue } else { 'OpenAI SDK default' })"
Write-Host "Fully exit Codex from the system tray, restart it, and open a new task."
