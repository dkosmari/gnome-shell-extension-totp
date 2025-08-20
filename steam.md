# Steam Guard

Steam Guard uses mostly standard TOTP:

 - The TOTP secret is named `shared_secret`, and will be stored in `Base64`
   encoding. After you save, the extension will convert it to `Base32`.

 - Steam Guard uses:

     - Digits: 5

     - Period: 30 seconds

     - Algorithm: SHA-1

 - Steam Guard uses decimal digits and letters to display authentication codes. To make
   the TOTP extension show the codes in the same way, you **must** set the **Issuer** to
   `Steam`.


## Importing TOTP secret from Steam Guard

We need to extract the `shared_secret` from Steam Guard. There are a few different ways to
obtain it, but here is one that's known to work:


### Prerequisites

 - Rooted Android device, with Steam Guard activated.

 - [frida-server](https://github.com/frida/frida/releases): Download the
   `frida-server-X.Y.Z-android-ARCH.xz` that matches your phone. If you don't know that
   your phone is `arm64` or `x86`/`x86_64`, it's probably `arm`. There's no risk in
   downloading the wrong architecture, it will simply not execute if you make a mistake.

   > Note that the latest frida version might not work with your Android version. You might need
   > to try older versions until you find one that works.

 - `adb`: Usually part of `android-tools` or `android-tools-adb` package.

 - USB cable to connect your phone to your PC.


### Preparation

1. Extract `frida-server` from the `.xz` archive:

       unxz frida-server-X.Y.Z-android-ARCH.xz

    Example:

        unxz frida-server-16.5.9-android-arm.xz

2. Save the following Python script, to a `dump.py` file:

   ```python
   #!/bin/env python3
   
   import json
   import frida
   import sys
   
   package = "com.valvesoftware.android.steam.community"
   cmd = """
   'use strict;'
   
   if (Java.available) {
     Java.perform(function() {
   
       //Cipher stuff
       const Cipher = Java.use('javax.crypto.Cipher');
   
       Cipher.doFinal.overload('[B').implementation = function (input) {
           var result = this.doFinal.overload('[B').call(this, input);
           send(result);
       }
   
     }
   )}
   """

   def parse_hook(cmd_):
       print('[*] Parsing hook...')
       script = session.create_script(cmd_)
       script = session.create_script(cmd_)
       script.on('message', on_message)
       script.load()
   
   def on_message(message, _):
       try:
           if message:
               if message['type'] == 'send':
                   result = "".join(chr(i) for i in message['payload'])
                   print(json.dumps(json.loads(result), indent=2, ensure_ascii=False))
       except Exception as e:
           print(e)
   
   if __name__ == '__main__':
       try:
           print('[*] Spawning', package)
           dev = frida.get_usb_device()
           pid = dev.spawn(package)
           session = dev.attach(pid)
           parse_hook(cmd)
           dev.resume(pid)
           print('')
           sys.stdin.read()
   
       except KeyboardInterrupt:
           sys.exit(0)
       except Exception as e:
           print(e)
   ```

   Make it executable by running `chmod +x dump.py`.

4. On your phone's app settings, use "Force Stop" to completely stop the Steam app.

5. Clear Steam's app cache. **DO NOT CLEAR THE STORAGE**.


### Extracting the secrets

1. Connect your phone to your PC using the USB cable. You must enable "USB debugging" in
   the developer options.
   
2. On your PC, run `adb devices` to verify everything is working. You might need to
   authorize the ADB connection on the phone before it can connect successfully.
   
3. Put the `frida-server` executable in your phone, by running this command:

       adb push frida-server-X.Y.Z-android-ARCH /data/local/tmp/

   Example:
   
       adb push frida-server-16.5.9-android-arm /data/local/tmp/

4. Log into your phone as root; one of these might work:
   
       adb root
       adb shell

   or
   
       adb shell
       su
   
   You might see a prompt on your phone to authorize root access for the adb shell. Make
   sure you allow root access.

5. Go to where you copied `frida-server` and execute it:

       cd /data/local/tmp
       chmod +x frida-server-X.Y.Z-android-ARCH
       ./frida-server-X.Y.Z-android-ARCH

    If you see any error messages, this probably means this version of `frida-server` is
    not compatible. Go download a different version and try again. You can press `Ctrl+C`
    to stop `frida-server`.
    
6. Run the `dump.py` script:

       ./dump.py

7. This script will automatically launch Steam on your phone. Navigate to the Steam Guard,
   to generate an authentication code. It will fail to show you the authentication code,
   but the script will print out the `shared_secret` that you need:

   ```json
   {
     "accounts": {
       "12345678901234567890": {
         "shared_secret": "ABC123abc123ABC123abc123ABC=",
         "identity_secret": "...",
         "secret_1": "...",
         "serial_number": "...",
         "revocation_code": "...",
         "account_name": "...",
         "token_gid": "...",
         "steamguard_scheme": 2,
         "steamid": "..."
       }
     }
   }
   ```

9. Use the `shared_secret` value as the TOTP secret, making sure to select `Base64`.

10. Close the Steam app.

11. Stop the `dump.py` script by pressing `Ctrl+C`.

12. Stop the `frida-server` by pressing `Ctrl+C`.

13. Open the Steam app again, and VERIFY that it generates the same authentication codes
    as the extension.
    
    > If the codes don't match, either you copied the `shared_secret` incorrectly, or you
    > didn't configure it correctly.

14. Delete the `frida-server` executable form your phone:
    
        rm frida-server-X.Y.Z-android-ARCH

