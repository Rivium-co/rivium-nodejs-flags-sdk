# Changelog

## 0.2.0

Breaking release. See the README for the short migration from 0.1.x.

- Rules are downloaded with your server secret and evaluated locally; results match the Rivium Flags server.
- Typed getters with a reason for every value.
- Automatic refresh with retries that respect rate limits; `close()` replaces `dispose()`.
- Rollouts and variant splits use a new hash, so users are re-bucketed once.

## 0.1.0

- Initial release.
