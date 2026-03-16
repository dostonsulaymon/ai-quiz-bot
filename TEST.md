# Test Coverage Notes

Current automated coverage focuses on high-risk business logic:

- AI response parsing: question ID deduplication and fallback ID assignment
- Leaderboard upsert rules: better-score and faster-tiebreak replacement behavior
- Formatting utilities: truncation and whitespace normalization
- i18n translation lookup and interpolation fallbacks
- Session state machine transition validation

Still worth covering next:

- Fisher-Yates question and option shuffling in the test flow
- Per-question timer expiry and timer cancellation behavior
- Upload, review, and edit callback flows
- Class sharing and deep-link access control
- Repository integration tests against a real MongoDB test instance
