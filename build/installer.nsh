; Keep a copy of this installer inside the install dir so this device can
; share it with other LAN peers for automatic peer-to-peer upgrades.
; Also enable WDDM graphics display driver for Remote Desktop Connections
; so dynamic window-resize resolution works out of the box.
!macro customInstall
  CreateDirectory "$INSTDIR\update"
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\update\EriiRemote-Setup.exe"
  WriteRegDWORD HKLM "SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" "fEnableWddmDriver" 1
!macroend
