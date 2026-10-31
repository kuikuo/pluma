; Let Pluma accept connections from other devices without the Windows Firewall pop-up.
; Removes any block rule Windows created if the pop-up was dismissed earlier.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\Pluma.exe"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pluma" dir=in action=allow program="$INSTDIR\Pluma.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pluma" dir=out action=allow program="$INSTDIR\Pluma.exe" enable=yes profile=any'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name=all program="$INSTDIR\Pluma.exe"'
!macroend
