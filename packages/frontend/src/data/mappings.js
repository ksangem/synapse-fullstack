export const initialMappings = [
  { src: 'key', dest: 'ExternalId', confidence: 95, type: 'confirmed' },
  { src: 'summary', dest: 'Title', confidence: 92, type: 'confirmed' },
  { src: 'assignee.displayName', dest: 'AssignedTo', confidence: 87, type: 'manual' },
  { src: 'status.name', dest: 'Status', confidence: 95, type: 'confirmed' },
  { src: 'priority.name', dest: 'Priority', confidence: 90, type: 'confirmed' },
  { src: 'created', dest: 'CreatedDate', confidence: 88, type: 'manual' },
  { src: 'updated', dest: 'ModifiedDate', confidence: 85, type: 'manual' },
  { src: 'description', dest: 'Description', confidence: 72, type: 'pending' },
  { src: 'labels', dest: 'Tags', confidence: 68, type: 'pending' },
  { src: 'reporter.displayName', dest: 'Reporter', confidence: 82, type: 'manual' },
];

export const sourceFields = [
  { name: 'key', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'assignee.accountId', type: 'string' },
  { name: 'assignee.displayName', type: 'string' },
  { name: 'status.name', type: 'string' },
  { name: 'priority.name', type: 'string' },
  { name: 'created', type: 'datetime' },
  { name: 'updated', type: 'datetime' },
  { name: 'description', type: 'text' },
  { name: 'labels', type: 'array' },
  { name: 'reporter.displayName', type: 'string' },
];

export const destFields = [
  { name: 'Title', type: 'string' },
  { name: 'Description', type: 'text' },
  { name: 'AssignedTo', type: 'string' },
  { name: 'Status', type: 'string' },
  { name: 'Priority', type: 'string' },
  { name: 'CreatedDate', type: 'date' },
  { name: 'ModifiedDate', type: 'date' },
  { name: 'ExternalId', type: 'string' },
  { name: 'Tags', type: 'string' },
  { name: 'Reporter', type: 'string' },
];

export const pairColors = ['mp-c1', 'mp-c2', 'mp-c3', 'mp-c4', 'mp-c5', 'mp-c6', 'mp-c7', 'mp-c8', 'mp-c9', 'mp-c10'];
