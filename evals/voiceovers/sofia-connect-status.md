# sofia-connect-status — Show non-blocking Connect lifecycle health

1. When signed in, the status bar shows Sofia Connect: Checking during startup, authentication restoration, or an OpenCode restart.

2. One shared lifecycle flow reconciles and checks Sofia Connect in the background. Messages remain unblocked.

3. Success changes the status to Sofia Connect: Ready.

4. After bounded retries fail, it turns red: Sofia Connect: Needs attention. Opening it offers Run diagnostics.

5. When signed out, the Sofia Connect status is not shown.
