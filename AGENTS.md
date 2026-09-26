# Brief instructions for code agents

## General
* ADD INFO HERE
* The code is written in TypeScript with minimal dependencies, pure CSS and HTML, bundled with Vite.
* ESLint lints both TypeScript and CSS, while `tsc` type-checks without emitting; Vite produces the final bundle.

## Code location
* TypeScript files are located in src/
* The HTML entry point is index.html and CSS files are located in src/assets/

## Project rules
* Do not embed HTML or CSS in typescript files
* Do absolutely minimal changes to other CSS rules if you do any CSS modification
* When adding new CSS rules, prefer adding id-based rules instead of class-based rules
* Add class-based CSS rules only if you see duplication in rules

## Build & testing commands
* Only attempt running any commands for building and testing as outlined here
* Install JavaScript/TypeScript libraries with `npm install`, do not run any other commands
* When changing TypeScript or html/css files, run `npm run build:ts` and `npm run test:ts`, do not run any other commands
* Run `npm run build` to check the final result in dist/
* Do not attempt opening browser for UI testing, always request the user to test the UI
