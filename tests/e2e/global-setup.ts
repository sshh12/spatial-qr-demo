import { buildFixtures } from "../../scripts/make-fixtures.mts";

/**
 * The camera fixtures are large and fully derived, so they are generated rather
 * than committed. Regenerating them every run also means the browser tests are
 * checking the current renderer, not a snapshot of one from months ago.
 */
export default function globalSetup(): void {
	buildFixtures(true);
}
