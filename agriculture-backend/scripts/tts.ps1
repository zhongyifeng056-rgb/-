<#
  把文本合成为 WAV（24kHz / 16bit / 单声道）
  用法: powershell -File tts.ps1 -TextFile in.txt -OutFile out.wav

  语音选择：优先用质量更好的中文语音（晓晓/云希/云扬等神经网络音色），
  没有就退回 Huihui，再没有就用任意中文语音。
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile
)
Add-Type -AssemblyName System.Speech
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { exit 2 }

$syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  24000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$voices = $syn.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' }
$prefer = @('Xiaoxiao', 'Xiaoyi', 'Yunxi', 'Yunyang', 'Yunjian', 'Huihui')
$picked = $null
foreach ($key in $prefer) {
  $picked = $voices | Where-Object { $_.VoiceInfo.Name -like "*$key*" } | Select-Object -First 1
  if ($picked) { break }
}
if (-not $picked) { $picked = $voices | Select-Object -First 1 }
if ($picked) { $syn.SelectVoice($picked.VoiceInfo.Name) }

$syn.Rate = 0
$syn.SetOutputToWaveFile($OutFile, $fmt)
$syn.Speak($text)
$syn.Dispose()

# 把实际用的音色写到旁边，方便排查
if ($picked) { [IO.File]::WriteAllText($OutFile + '.voice', $picked.VoiceInfo.Name, [Text.Encoding]::UTF8) }
exit 0
