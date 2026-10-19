// Tools Claude can call that run here rather than on Anthropic's side: a
// long-term memory of facts about the user, and timers the browser rings.
const store = require('./store');

const MAX_MEMORIES = 100;
const MAX_TIMER_SECONDS = 24 * 60 * 60;

// Every memory is sent with every request, so keep each one short
const MAX_FACT_CHARS = 300;

let memories = store.load('memories', []);

// strict keeps the arguments schema-valid; eager streaming lets the input
// arrive as it is written instead of in one burst at the end, which means the
// API no longer checks it for us, so run() validates everything itself
const DEFINITIONS = [
  {
    name: 'remember',
    description:
      'Save a lasting fact about the user so you know it in future conversations, ' +
      'such as their name, where they live, preferences, or people and things that ' +
      'matter to them. Use it when they tell you something worth keeping or ask you ' +
      'to remember something. Do not save small talk or one-off requests.',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact, as a short sentence about the user.' }
      },
      required: ['fact'],
      additionalProperties: false
    },
    strict: true,
    eager_input_streaming: true
  },
  {
    name: 'forget',
    description:
      'Delete a saved fact about the user, by the id shown next to it in your memory. ' +
      'Use it when they ask you to forget something or a fact is no longer true.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The id of the fact to delete.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    strict: true,
    eager_input_streaming: true
  },
  {
    name: 'set_timer',
    description:
      'Start a timer or reminder that chimes in the browser when it is up. Work out ' +
      'the number of seconds from now yourself, using the current time you were given ' +
      'for reminders at a clock time. Timers live in the open page, so they are lost ' +
      'if it is closed or reloaded. Maximum 24 hours.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: 'Seconds from now until it goes off.' },
        label: { type: 'string', description: 'What it is for, shown when it goes off, e.g. "Pasta".' }
      },
      required: ['seconds', 'label'],
      additionalProperties: false
    },
    strict: true,
    eager_input_streaming: true
  }
];

// Rendered into the system prompt on every request
function describeMemories() {
  if (!memories.length) return 'You have no saved facts about the user yet.';
  return [
    'Facts you have saved about the user (id: fact):',
    ...memories.map((m) => `${m.id}: ${m.fact}`)
  ].join('\n');
}

// Shared by the forget tool and the memory panel in the page
function listMemories() {
  return memories.map(({ id, fact, savedAt }) => ({ id, fact, savedAt }));
}

function removeMemory(id) {
  const index = memories.findIndex((m) => m.id === id);
  if (index === -1) return null;
  const [removed] = memories.splice(index, 1);
  store.save('memories', memories);
  return removed;
}

function nextId() {
  return memories.reduce((max, m) => Math.max(max, m.id), 0) + 1;
}

function fail(message) {
  return { content: message, is_error: true };
}

// Runs one tool_use block. onTimer is how a timer reaches the browser.
// Returns the tool_result fields; never throws for bad input, since Claude can
// read the error and correct itself.
function run(block, { onTimer }) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};

  switch (block.name) {
    case 'remember': {
      const fact = typeof input.fact === 'string' ? input.fact.trim() : '';
      if (!fact) return fail('fact must be a non-empty string');
      if (fact.length > MAX_FACT_CHARS) return fail(`fact must be under ${MAX_FACT_CHARS} characters`);
      if (memories.length >= MAX_MEMORIES) {
        return fail(`Memory is full (${MAX_MEMORIES} facts). Ask the user what to forget first.`);
      }
      const memory = { id: nextId(), fact, savedAt: new Date().toISOString() };
      memories.push(memory);
      store.save('memories', memories);
      return { content: `Saved as fact ${memory.id}.` };
    }

    case 'forget': {
      const removed = removeMemory(input.id);
      if (!removed) return fail(`No saved fact has id ${input.id}`);
      return { content: `Forgot: ${removed.fact}` };
    }

    case 'set_timer': {
      const { seconds } = input;
      const label = typeof input.label === 'string' ? input.label.trim() : '';
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMER_SECONDS) {
        return fail(`seconds must be a whole number from 1 to ${MAX_TIMER_SECONDS}`);
      }
      onTimer({ seconds, label: label || 'Timer' });
      return { content: `Timer set for ${seconds} seconds.` };
    }

    default:
      return fail(`Unknown tool ${block.name}`);
  }
}

module.exports = { DEFINITIONS, run, describeMemories, listMemories, removeMemory };
