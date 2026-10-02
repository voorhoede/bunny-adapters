import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AstroError } from 'astro/errors';
import bunny from '../dist/index.js';

describe('the script option', () => {
	it('builds a standalone script unless told otherwise', () => {
		assert.doesNotThrow(() => bunny());
		assert.doesNotThrow(() => bunny({ script: 'standalone' }));
		assert.doesNotThrow(() => bunny({ script: 'middleware' }));
	});

	it('refuses a script type it does not know, naming the ones it does', () => {
		assert.throws(
			() => bunny({ script: 'worker' }),
			(error) => error instanceof AstroError && /standalone.*middleware/.test(error.message),
		);
	});
});
