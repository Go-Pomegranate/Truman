## ADDED Requirements

### Requirement: Execute click-link action
The adapter SHALL click the element identified by `params.selector`, wait for navigation or DOM mutation (max 8s), and return the new URL and page title.

#### Scenario: Link navigates to new page
- **WHEN** `executeAction({ name: "click-link-3", params: { selector: "a#about" } })` is called
- **THEN** the adapter clicks the link, waits for navigation, and returns `{ success: true, duration, response: { url, title } }`

#### Scenario: Link element is stale
- **WHEN** the selector points to an element that no longer exists
- **THEN** the adapter returns `{ success: false, error: "Element not found or page changed", duration }`

### Requirement: Execute click-button action
The adapter SHALL click the button identified by `params.selector`, wait for DOM mutation (max 5s), and return whether the page changed.

#### Scenario: Button triggers modal
- **WHEN** `executeAction({ name: "click-button-1", params: { selector: "button#login" } })` is called
- **THEN** the adapter clicks the button and returns `{ success: true, duration }`

### Requirement: Execute fill-input action
The adapter SHALL focus and fill the input identified by `params.selector` with `params.value`.

#### Scenario: Fill email input
- **WHEN** `executeAction({ name: "fill-input-0", params: { selector: "input[name='email']", value: "user@test.com" } })` is called
- **THEN** the adapter fills the input with "user@test.com" and returns `{ success: true, duration, response: { filled: "user@test.com" } }`

#### Scenario: Input not found
- **WHEN** the selector points to a non-existent input
- **THEN** the adapter returns `{ success: false, error: "Element not found or page changed", duration }`

### Requirement: Execute select-option action
The adapter SHALL select the option matching `params.value` in the select element identified by `params.selector`.

#### Scenario: Select country
- **WHEN** `executeAction({ name: "select-option-0", params: { selector: "select#country", value: "Poland" } })` is called
- **THEN** the adapter selects "Poland" and returns `{ success: true, duration }`

### Requirement: Execute toggle-check action
The adapter SHALL click the checkbox/radio identified by `params.selector` to toggle its state.

#### Scenario: Check a checkbox
- **WHEN** `executeAction({ name: "toggle-check-0", params: { selector: "input#terms" } })` is called
- **THEN** the adapter clicks the checkbox and returns `{ success: true, duration, response: { toggled: true } }`

### Requirement: Execute scroll actions
The adapter SHALL scroll the page by 80% of the viewport height in the specified direction and wait 300ms for lazy-loaded content.

#### Scenario: Scroll down
- **WHEN** `executeAction({ name: "scroll-down", params: {} })` is called
- **THEN** the page scrolls down by 80% of viewport height and returns `{ success: true, duration }`

### Requirement: Execute go-back action
The adapter SHALL navigate the browser back and return the resulting URL.

#### Scenario: Go back to previous page
- **WHEN** `executeAction({ name: "go-back", params: {} })` is called
- **THEN** the browser navigates back and returns `{ success: true, duration, response: { url } }`

### Requirement: Execute wait action
The adapter SHALL wait 1 second without performing any action.

#### Scenario: Wait and observe
- **WHEN** `executeAction({ name: "wait", params: {} })` is called
- **THEN** the adapter waits 1s and returns `{ success: true, duration: 1000 }`

### Requirement: Take screenshot after every action
The adapter SHALL take a screenshot after every `executeAction()` call, saved to `screenshotDir` with a sequential numbered filename.

#### Scenario: Screenshot after click
- **WHEN** any action completes (success or failure)
- **THEN** a screenshot is saved as `{NNN}-{memberId}-{actionName}.png`

### Requirement: Anonymous authentication
The adapter SHALL open a browser, navigate to `baseUrl`, and return a dummy `AuthContext` without sending any custom auth headers.

#### Scenario: First visit
- **WHEN** `authenticate(member, family)` is called
- **THEN** a new browser context is created, the page navigates to `baseUrl`, and returns `{ token: "truman-{memberId}", memberId, headers: {} }`

### Requirement: Per-member browser contexts
The adapter SHALL create a separate browser context and page for each member, stored in a map keyed by `memberId`, to support concurrent sessions.

#### Scenario: Two members authenticate concurrently
- **WHEN** `authenticate(memberA)` and `authenticate(memberB)` are called
- **THEN** each gets their own browser context and page, with isolated cookies and storage

### Requirement: Cleanup closes member context
The adapter SHALL close the member's browser context when `cleanup()` is called.

#### Scenario: Session ends
- **WHEN** `cleanup(ctx)` is called for a member
- **THEN** the member's browser context is closed and removed from the map

### Requirement: Close shuts down browser
The adapter SHALL close the entire browser instance when `close()` is called.

#### Scenario: Simulation ends
- **WHEN** `close()` is called
- **THEN** the browser is closed and all contexts are destroyed
