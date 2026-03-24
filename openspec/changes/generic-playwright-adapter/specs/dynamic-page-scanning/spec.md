## ADDED Requirements

### Requirement: Scan page for interactive elements
The adapter SHALL scan the current page DOM on every `getAvailableActions()` call and return visible interactive elements as `AvailableAction[]`.

#### Scenario: Page with links, buttons, and inputs
- **WHEN** `getAvailableActions()` is called on a page with 3 links, 2 buttons, and 1 text input
- **THEN** it returns 6 dynamic actions plus 4 static actions (scroll-down, scroll-up, go-back, wait)

#### Scenario: Empty page
- **WHEN** `getAvailableActions()` is called on a page with no interactive elements
- **THEN** it returns only the 4 static actions

### Requirement: Discover links
The adapter SHALL discover visible `<a>` elements with valid `href` attributes and return them as `click-link-N` actions with category `navigation`.

#### Scenario: Standard link
- **WHEN** the page contains `<a href="/about">About Us</a>`
- **THEN** a `click-link-N` action is returned with description containing "About Us" and "/about", and a `selector` param with `example` set to the CSS selector

#### Scenario: JavaScript href excluded
- **WHEN** the page contains `<a href="javascript:void(0)">Click</a>`
- **THEN** this element is NOT included in the results

#### Scenario: Hash-route link included
- **WHEN** the page contains `<a href="#/dashboard">Dashboard</a>`
- **THEN** this element IS included (SPA routing)

#### Scenario: Bare anchor excluded
- **WHEN** the page contains `<a href="#">Top</a>`
- **THEN** this element is NOT included

### Requirement: Discover buttons
The adapter SHALL discover visible `<button>`, `[role=button]`, and `input[type=submit]` elements and return them as `click-button-N` actions with category `interaction`.

#### Scenario: Standard button
- **WHEN** the page contains `<button>Submit Form</button>`
- **THEN** a `click-button-N` action is returned with description containing "Submit Form"

#### Scenario: Disabled button excluded
- **WHEN** the page contains `<button disabled>Submit</button>`
- **THEN** this element is NOT included

### Requirement: Discover text inputs
The adapter SHALL discover visible `<input>` (types: text, email, password, search, tel, url) and `<textarea>` elements and return them as `fill-input-N` actions with category `form`.

#### Scenario: Email input
- **WHEN** the page contains `<input type="email" placeholder="Enter email">`
- **THEN** a `fill-input-N` action is returned with a required `selector` param and a required `value` param of type `string`

#### Scenario: File input excluded
- **WHEN** the page contains `<input type="file">`
- **THEN** this element is NOT included

#### Scenario: Hidden input excluded
- **WHEN** the page contains `<input type="hidden" name="csrf">`
- **THEN** this element is NOT included

### Requirement: Discover select elements
The adapter SHALL discover visible `<select>` elements and return them as `select-option-N` actions with category `form`, including available options as `enumValues`.

#### Scenario: Country selector
- **WHEN** the page contains a `<select>` with options "USA", "UK", "Poland"
- **THEN** a `select-option-N` action is returned with a `value` param of type `enum` and `enumValues: ["USA", "UK", "Poland"]`

### Requirement: Discover checkboxes and radios
The adapter SHALL discover visible checkbox and radio inputs and return them as `toggle-check-N` actions with category `form`.

#### Scenario: Unchecked checkbox
- **WHEN** the page contains `<input type="checkbox" id="terms">` that is unchecked
- **THEN** a `toggle-check-N` action is returned with description indicating current state is unchecked

### Requirement: Cap scanned elements
The adapter SHALL return at most 40 interactive elements per scan, prioritizing above-the-fold elements first, then by DOM order.

#### Scenario: Page with 100 links
- **WHEN** `getAvailableActions()` is called on a page with 100 links
- **THEN** at most 40 link actions are returned plus the 4 static actions

### Requirement: Generate stable selectors
The adapter SHALL generate a CSS selector for each element using the priority: `[data-testid]` > `#id` > `[aria-label]` > Playwright text selector > nth-of-type CSS path.

#### Scenario: Element with data-testid
- **WHEN** an element has `data-testid="submit-btn"`
- **THEN** its selector is `[data-testid="submit-btn"]`

#### Scenario: Element with unique ID
- **WHEN** an element has `id="main-nav"` and no data-testid
- **THEN** its selector is `#main-nav`

### Requirement: Provide page state via accessibility tree
The adapter SHALL return the current page's accessibility tree (depth 4, max 50 nodes) as the `summary` in `getAppState()`, along with the page URL and title.

#### Scenario: Standard page
- **WHEN** `getAppState()` is called
- **THEN** the summary contains the page title, pathname, flattened accessibility tree, visible headings, and any error/alert elements

#### Scenario: Summary capped at 800 chars
- **WHEN** the accessibility tree produces more than 800 characters
- **THEN** the summary is truncated to 800 characters
