## Summary

Adds `GET /preview?url=` so the chat UI can show a title for pasted links. The server fetches the page and returns its `<title>`, which avoids CORS problems in the browser.
