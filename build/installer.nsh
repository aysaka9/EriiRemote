; Keep a copy of this installer inside the install dir so this device can
; share it with other LAN peers for automatic peer-to-peer upgrades.
!macro customInstall
  CreateDirectory "$INSTDIR\update"
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\update\EriiRemote-Setup.exe"
!macroend
