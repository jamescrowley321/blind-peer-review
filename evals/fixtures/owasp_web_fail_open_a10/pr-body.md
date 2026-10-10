## Summary

The admin console logged people out whenever the session store timed out. The admin gate now logs the error and lets the request through instead of returning 500.
