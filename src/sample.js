/**
 * "Start from template": the sample table from seed.sql, built through the normal API code so it is
 * exactly what a user could build by hand. Fictional rows; every domain is under example.com
 * (reserved for examples, RFC 2606), so running its columns can never reach a real business.
 * Generated from seed.sql; computed cells start empty so the first Run shows the product working.
 */

import { createTable, createColumn, insertRows, loadColumns } from './tables.js';

export const SAMPLE = {
  "columns": [
    {
      "key": "company",
      "name": "Company",
      "kind": "data",
      "type": "text",
      "config": {}
    },
    {
      "key": "website",
      "name": "Website",
      "kind": "data",
      "type": "url",
      "config": {}
    },
    {
      "key": "first_name",
      "name": "First name",
      "kind": "data",
      "type": "text",
      "config": {}
    },
    {
      "key": "last_name",
      "name": "Last name",
      "kind": "data",
      "type": "text",
      "config": {}
    },
    {
      "key": "city",
      "name": "City",
      "kind": "data",
      "type": "text",
      "config": {}
    },
    {
      "key": "domain",
      "name": "Domain",
      "kind": "formula",
      "type": "text",
      "config": {
        "formula": "DOMAIN({{website}})"
      }
    },
    {
      "key": "email_provider",
      "name": "Email provider",
      "kind": "enrich",
      "type": "text",
      "config": {
        "fn": "email_provider",
        "inputs": {
          "domain": "{{domain}}"
        },
        "outputs": [],
        "condition": "",
        "auto": false
      }
    },
    {
      "key": "site_status",
      "name": "Site status",
      "kind": "enrich",
      "type": "select",
      "config": {
        "fn": "website_check",
        "inputs": {
          "domain": "{{domain}}"
        },
        "outputs": [],
        "condition": "",
        "auto": false
      }
    },
    {
      "key": "work_email",
      "name": "Work email",
      "kind": "waterfall",
      "type": "email",
      "config": {
        "steps": [
          {
            "fn": "find_contact_info",
            "inputs": {
              "domain": "{{domain}}"
            },
            "enabled": true
          },
          {
            "fn": "hunter_email_finder",
            "inputs": {
              "first_name": "{{first_name}}",
              "last_name": "{{last_name}}",
              "domain": "{{domain}}"
            },
            "enabled": false
          },
          {
            "fn": "email_permutations",
            "inputs": {
              "first_name": "{{first_name}}",
              "last_name": "{{last_name}}",
              "domain": "{{domain}}"
            },
            "enabled": true
          }
        ],
        "validate": {
          "fn": "email_check",
          "pass": "valid"
        },
        "provider_column": null,
        "outputs": [],
        "condition": "NOT(ISBLANK({{domain}}))",
        "auto": false
      }
    },
    {
      "key": "residential",
      "name": "Does residential?",
      "kind": "ai",
      "type": "checkbox",
      "config": {
        "provider": "groq",
        "model": "qwen/qwen3.8-27b",
        "prompt": "Does {{company}} ({{website}}) do residential roofing? Answer from the name only if you must.",
        "system": "",
        "fields": [
          {
            "name": "residential",
            "type": "checkbox"
          }
        ],
        "outputs": [],
        "max_tokens": 256,
        "est_input_tokens": 120,
        "condition": "",
        "auto": false
      }
    }
  ],
  "rows": [
    {
      "company": "Gator Ridge Roofing",
      "website": "https://www.gatorridge.example.com",
      "first_name": "Dana",
      "last_name": "Whitfield",
      "city": "Gainesville"
    },
    {
      "company": "Suncoast Shingle Co",
      "website": "suncoastshingle.example.com",
      "first_name": "Marco",
      "last_name": "Reyes",
      "city": "Tampa"
    },
    {
      "company": "Palmetto Peak Roofs",
      "website": "palmettopeak.example.com",
      "first_name": "Leah",
      "last_name": "Okafor",
      "city": "Orlando"
    },
    {
      "company": "Keystone Coastal Roofing",
      "website": "keystonecoastal.example.com",
      "first_name": "Sam",
      "last_name": "Duarte",
      "city": "Jacksonville"
    },
    {
      "company": "Blue Heron Roof Repair",
      "website": "blueheron.example.com",
      "first_name": "Priya",
      "last_name": "Nair",
      "city": "Ocala"
    },
    {
      "company": "Tri-County Roof Pros",
      "first_name": "Owen",
      "last_name": "Baptiste",
      "city": "Lakeland"
    },
    {
      "company": "Coquina Roofing & Gutters",
      "website": "https://coquina.example.com/contact",
      "first_name": "Rosa",
      "last_name": "Lindqvist",
      "city": "St. Augustine"
    },
    {
      "company": "Seminole State Roofing",
      "website": "seminolestate.example.com",
      "city": "Sanford"
    }
  ]
};

export async function createSample(db) {
  const t = await createTable(db, { name: 'Sample: Florida roofers', csv: null });
  // createTable adds a default Name column; the sample brings its own, so drop it first.
  const first = await loadColumns(db, t.id);
  for (const c of first) await db.prepare('DELETE FROM columns WHERE id=?1').bind(c.id).run();
  for (const c of SAMPLE.columns) await createColumn(db, t.id, { name: c.name, kind: c.kind, type: c.type, config: c.config });
  const cols = await loadColumns(db, t.id);
  await insertRows(db, t.id, SAMPLE.rows, cols);
  return { id: t.id, name: t.name };
}
