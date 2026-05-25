/**
 * Maps SharePoint field types to canonical JSON values.
 *
 * Covers all 10 SP types from the type coercion reference (Section 8).
 * Never lossy — complex types produce structured JSON objects.
 */

import type { SpFieldType, RawSpItem, MappedSpItem, SpColumnDefinition } from './types';

export class SharePointFieldTypeMapper {
  /**
   * Detect field type from a Graph column definition object.
   */
  static detectFieldType(columnDef: Record<string, unknown>): SpFieldType {
    if (columnDef.text !== undefined && columnDef.text !== null) {
      const textDef = columnDef.text as Record<string, unknown>;
      if (textDef.allowMultipleLines === true) return 'note';
      return 'text';
    }
    if (columnDef.number !== undefined && columnDef.number !== null) return 'number';
    if (columnDef.currency !== undefined && columnDef.currency !== null) return 'currency';
    if (columnDef.dateTime !== undefined && columnDef.dateTime !== null) return 'dateTime';
    if (columnDef.boolean !== undefined && columnDef.boolean !== null) return 'boolean';
    if (columnDef.choice !== undefined && columnDef.choice !== null) {
      const choiceDef = columnDef.choice as Record<string, unknown>;
      if (choiceDef.allowMultipleSelections === true) return 'choiceMulti';
      return 'choiceSingle';
    }
    if (columnDef.personOrGroup !== undefined && columnDef.personOrGroup !== null) return 'person';
    if (columnDef.lookup !== undefined && columnDef.lookup !== null) return 'lookup';
    if (columnDef.hyperlinkOrPicture !== undefined && columnDef.hyperlinkOrPicture !== null) return 'hyperlink';
    if (columnDef.term !== undefined && columnDef.term !== null) return 'managedMetadata';
    return 'text'; // fallback
  }

  /**
   * Map a raw field value from SharePoint to canonical JSON based on its type.
   */
  static mapFieldValue(value: unknown, fieldType: SpFieldType): unknown {
    if (value === null || value === undefined) return null;

    switch (fieldType) {
      case 'text':
      case 'note':
        return String(value);

      case 'number':
      case 'currency':
        return typeof value === 'number' ? value : Number(value);

      case 'dateTime':
        // Always return ISO-8601 string
        if (typeof value === 'string') return value;
        if (value instanceof Date) return value.toISOString();
        return String(value);

      case 'boolean':
        if (typeof value === 'boolean') return value;
        return value === 'true' || value === '1' || value === 1;

      case 'choiceSingle':
        return String(value);

      case 'choiceMulti':
        if (Array.isArray(value)) return value.map(String);
        if (typeof value === 'string') {
          // SP sometimes returns comma-separated or semicolon-separated
          return value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
        }
        return [String(value)];

      case 'person':
        return SharePointFieldTypeMapper.mapPersonValue(value);

      case 'lookup':
        return SharePointFieldTypeMapper.mapLookupValue(value);

      case 'hyperlink':
        return SharePointFieldTypeMapper.mapHyperlinkValue(value);

      case 'managedMetadata':
        // Return the full term path as a string
        if (typeof value === 'object' && value !== null) {
          const term = value as Record<string, unknown>;
          return term.label ?? term.termPath ?? String(value);
        }
        return String(value);

      default:
        return value;
    }
  }

  /**
   * Map a Person/Group field to { displayName, email, upn }.
   */
  private static mapPersonValue(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null) {
      const person = value as Record<string, unknown>;
      return {
        displayName: person.LookupValue ?? person.displayName ?? person.title ?? null,
        email: person.Email ?? person.email ?? person.mail ?? null,
        upn: person.UserPrincipalName ?? person.userPrincipalName ?? null,
      };
    }
    // If it's just a string (display name), wrap it
    return { displayName: String(value), email: null, upn: null };
  }

  /**
   * Map a Lookup field to { id, value }.
   */
  private static mapLookupValue(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null) {
      const lookup = value as Record<string, unknown>;
      return {
        id: lookup.LookupId ?? lookup.lookupId ?? lookup.id ?? null,
        value: lookup.LookupValue ?? lookup.lookupValue ?? lookup.value ?? null,
      };
    }
    return { id: null, value: String(value) };
  }

  /**
   * Map a Hyperlink/Picture field to { url, description }.
   */
  private static mapHyperlinkValue(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null) {
      const link = value as Record<string, unknown>;
      return {
        url: link.Url ?? link.url ?? null,
        description: link.Description ?? link.description ?? null,
      };
    }
    // If it's a plain URL string
    if (typeof value === 'string') {
      return { url: value, description: null };
    }
    return { url: null, description: null };
  }

  /**
   * Map a full RawSpItem into a MappedSpItem with canonical field values.
   * columnDefs provides type information for each field.
   */
  static mapItem(
    item: RawSpItem,
    columnDefs: Map<string, SpFieldType>,
  ): MappedSpItem {
    const event = SharePointFieldTypeMapper.detectEvent(item);
    const mappedFields: Record<string, unknown> = {};

    if (item.fields) {
      for (const [fieldName, rawValue] of Object.entries(item.fields)) {
        const fieldType = columnDefs.get(fieldName) ?? 'text';
        mappedFields[fieldName] = SharePointFieldTypeMapper.mapFieldValue(rawValue, fieldType);
      }
    }

    return {
      spItemId: item.id,
      event,
      fields: mappedFields,
      raw: item,
    };
  }

  /**
   * Detect whether an item was created, updated, or deleted from the delta response.
   */
  static detectEvent(item: RawSpItem): 'created' | 'updated' | 'deleted' {
    if (item['@removed']) return 'deleted';
    // Graph delta doesn't distinguish created vs updated in a clean way.
    // If createdDateTime === lastModifiedDateTime (within 1s tolerance), treat as created.
    if (item.createdDateTime && item.lastModifiedDateTime) {
      const created = new Date(item.createdDateTime).getTime();
      const modified = new Date(item.lastModifiedDateTime).getTime();
      if (Math.abs(modified - created) < 1000) return 'created';
    }
    return 'updated';
  }
}
