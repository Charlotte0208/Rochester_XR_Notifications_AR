#requires -Version 7.4
<#
.SYNOPSIS
Creates the local HTTPS certificate used by the Quest AR development server.
.DESCRIPTION
Run again after changing Wi-Fi networks. A matching, unexpired certificate is
reused. Only files in this project's data directory are written; this script
does not modify certificate trust stores or firewall settings.
#>
param(
    [string]$IpAddress,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$certificateDirectory = Join-Path $projectDirectory 'data'
$pfxPath = Join-Path $certificateDirectory 'rochester-lan-https.pfx'
$cerPath = Join-Path $certificateDirectory 'rochester-lan-https.cer'
$certificatePassword = 'codex-local-vr'

if (-not $IpAddress) {
    $wifiAdapters = @(Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and ($_.NdisPhysicalMedium -eq 9 -or $_.MediaType -eq 'Native 802.11')
    })
    $wifiAddresses = @($wifiAdapters | ForEach-Object {
        Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 |
            Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' }
    })
    if ($wifiAddresses.Count -ne 1) {
        throw 'Could not choose exactly one active Wi-Fi IPv4 address. Run with -IpAddress <Wi-Fi IPv4>.'
    }
    $IpAddress = $wifiAddresses[0].IPAddress
}

$lanAddress = [System.Net.IPAddress]::Parse($IpAddress)
if ($lanAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    [System.Net.IPAddress]::IsLoopback($lanAddress) -or $IpAddress -like '169.254.*') {
    throw '-IpAddress must be a usable LAN IPv4 address.'
}

$certificate = $null
try {
    if ((Test-Path -LiteralPath $pfxPath) -and -not $Force) {
        try {
            $existing = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
                [System.IO.File]::ReadAllBytes($pfxPath), $certificatePassword,
                [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
            )
            $san = [System.Security.Cryptography.X509Certificates.X509SubjectAlternativeNameExtension]::new()
            $san.CopyFrom(($existing.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }))
            $ipNames = @($san.EnumerateIPAddresses() | ForEach-Object { $_.ToString() })
            if ($existing.HasPrivateKey -and $existing.NotAfter -gt (Get-Date).AddDays(14) -and
                @($san.EnumerateDnsNames()) -contains 'localhost' -and
                $ipNames -contains $IpAddress -and $ipNames -contains '127.0.0.1') {
                $certificate = $existing
                Write-Host 'Reusing the current local HTTPS certificate.'
            } else {
                $existing.Dispose()
            }
        } catch {
            if ($existing) { $existing.Dispose() }
            Write-Host 'Replacing an unreadable or incompatible local HTTPS certificate.'
        }
    }

    if (-not $certificate) {
        [System.IO.Directory]::CreateDirectory($certificateDirectory) | Out-Null
        $key = [System.Security.Cryptography.RSA]::Create(2048)
        try {
            $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
                'CN=Rochester Quest AR Local', $key,
                [System.Security.Cryptography.HashAlgorithmName]::SHA256,
                [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
            )
            $sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
            $sanBuilder.AddDnsName('localhost')
            $sanBuilder.AddIpAddress([System.Net.IPAddress]::Loopback)
            $sanBuilder.AddIpAddress($lanAddress)
            $request.CertificateExtensions.Add($sanBuilder.Build())
            $request.CertificateExtensions.Add(
                [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
            )
            $usage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
            $request.CertificateExtensions.Add(
                [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true)
            )
            $purposes = [System.Security.Cryptography.OidCollection]::new()
            [void]$purposes.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
            $request.CertificateExtensions.Add(
                [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($purposes, $false)
            )
            $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5), [DateTimeOffset]::Now.AddYears(1))
            [System.IO.File]::WriteAllBytes($pfxPath, $certificate.Export(
                [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $certificatePassword
            ))
            Write-Host 'Created the local HTTPS certificate.'
        } finally {
            $key.Dispose()
        }
    }

    [System.IO.File]::WriteAllBytes($cerPath, $certificate.Export(
        [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert
    ))
    Write-Host "PFX: $pfxPath"
    Write-Host "Public certificate: $cerPath"
    Write-Host "Expires: $($certificate.NotAfter.ToString('yyyy-MM-dd'))"
    Write-Host "Quest URL: https://${IpAddress}:5182/"
    Write-Host 'Start (or restart) the server with npm run dev. The self-signed certificate still requires browser acceptance or device trust.'
} finally {
    if ($certificate) { $certificate.Dispose() }
}
