<#
.SYNOPSIS
    Compila as imagens do Deskcomm no Docker do WSL (notebook) e envia para 10.1.1.4.
.DESCRIPTION
    Plano B de compilação local: não consome memória da VM de produção e não
    depende de cotas de minutos do GitHub Actions.
.EXAMPLE
    .\scripts\construir-local.ps1 -Enviar
#>
[CmdletBinding()]
param(
    [switch]$Enviar
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RootDir = Split-Path -Parent $ScriptDir

# Converter caminho do Windows para formato WSL (/mnt/d/...)
$WslPath = $RootDir -replace '\\', '/' -replace '^([A-Za-z]):', { '/mnt/' + $_.Groups[1].Value.ToLower() }

Write-Host "== Disparando build local no WSL: $WslPath" -ForegroundColor Cyan

$CmdArgs = ""
if ($Enviar) {
    $CmdArgs = "--enviar"
}

$WslCmd = "cd '$WslPath' && bash scripts/construir-local.sh $CmdArgs"
wsl.exe -d Ubuntu -e bash -c $WslCmd

if ($LASTEXITCODE -ne 0) {
    Write-Error "Falha na compilação ou envio local (código $LASTEXITCODE)"
} else {
    Write-Host "== Processo concluído com sucesso!" -ForegroundColor Green
}
