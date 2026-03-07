import { z } from 'zod/v4';

export const cardCustomFieldsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (customFields) => !Object.prototype.hasOwnProperty.call(customFields, 'checklist'),
    { message: 'customFields.checklist is no longer supported' },
  );
