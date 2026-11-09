import * as migration_20261005_034225_initial from './20261005_034225_initial';
import * as migration_20261017_185426_supertext_settings from './20261017_185426_supertext_settings';
import * as migration_20261018_222059_translation_review from './20261018_222059_translation_review';

export const migrations = [
  {
    up: migration_20261005_034225_initial.up,
    down: migration_20261005_034225_initial.down,
    name: '20261005_034225_initial',
  },
  {
    up: migration_20261017_185426_supertext_settings.up,
    down: migration_20261017_185426_supertext_settings.down,
    name: '20261017_185426_supertext_settings',
  },
  {
    up: migration_20261018_222059_translation_review.up,
    down: migration_20261018_222059_translation_review.down,
    name: '20261018_222059_translation_review'
  },
];
