// audit-template.mjs
// Loader for the audit report. Reads the HTML, CSS and JS pieces once,
// inlines CSS and JS into the HTML, then substitutes {{PLACEHOLDER}} tokens
// with the values supplied by audit-svg.mjs.
//
// The result is a single self-contained HTML file, ready for PDF export.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  html: join(__dirname, 'audit-template.html'),
  css:  join(__dirname, 'audit-template.css'),
  js:   join(__dirname, 'audit-template.js'),
};

let cached = null;

function loadParts() {
  if (cached === null) {
    cached = {
      html: readFileSync(PATHS.html, 'utf8'),
      css:  readFileSync(PATHS.css,  'utf8'),
      js:   readFileSync(PATHS.js,   'utf8'),
    };
  }
  return cached;
}

/**
 * Render the audit HTML report.
 * @param {Record<string, string|number>} data
 *   Values for the data placeholders (TITLE, TOTAL, TOTAL_PLURAL, MIN,
 *   WARN_COUNT, EMPTY_STATE, CARDS). CSS and JS are provided internally.
 * @returns {string}
 */
export function renderAuditHtml(data) {
  const { html, css, js } = loadParts();
  const all = Object.assign({}, data, { CSS: css, JS: js });
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(all, key)
      ? String(all[key])
      : match;
  });
}