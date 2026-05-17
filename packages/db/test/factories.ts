import { db, providerPool } from '../src/client';
import { projects } from '../src/schema/projects';
import { memberships, organizations, users } from '../src/schema/tenancy';
import { withTenant } from '../src/wrappers/with-tenant';

export interface TestOrg {
  id: string;
  name: string;
  projects: Array<{ id: string; name: string }>;
  users: Array<{ id: string; role: 'manager' | 'agent' }>;
}

export interface TestProviderUser {
  id: string;
  email: string;
}

export async function createTestOrg(name: string, slug?: string): Promise<TestOrg> {
  const [org] = await db
    .insert(organizations)
    .values({ name, slug: slug ?? name.toLowerCase().replace(/\s+/g, '-') })
    .returning();

  if (!org) throw new Error('Failed to create test org');

  const [manager] = await db
    .insert(users)
    .values({
      email: `manager-${org.id}@test.local`,
      name: 'Test Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning();

  if (!manager) throw new Error('Failed to create test manager');

  await db.insert(memberships).values({
    userId: manager.id,
    orgId: org.id,
    role: 'manager',
    isPrimary: true,
    acceptedAt: new Date(),
  });

  const testProjects = await withTenant(org.id, async (tx) => {
    const [proj1] = await tx
      .insert(projects)
      .values({
        orgId: org.id,
        name: `${name} Project 1`,
        type: 'tama38_1',
        createdBy: manager.id,
      })
      .returning();

    const [proj2] = await tx
      .insert(projects)
      .values({
        orgId: org.id,
        name: `${name} Project 2`,
        type: 'pinui_binui',
        createdBy: manager.id,
      })
      .returning();

    return [proj1!, proj2!];
  });

  return {
    id: org.id,
    name: org.name,
    projects: testProjects.map((p) => ({ id: p.id, name: p.name })),
    users: [{ id: manager.id, role: 'manager' }],
  };
}

export async function createTestProviderUser(): Promise<TestProviderUser> {
  const client = await providerPool.connect();
  try {
    const result = await client.query<{ id: string; email: string }>(
      `INSERT INTO provider_users
         (email, name, password_hash, mfa_secret_encrypted, recovery_codes_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, email`,
      [
        `provider-${Date.now()}@test.local`,
        'Test Provider Admin',
        '$2b$12$placeholder',
        Buffer.from('test-mfa-placeholder'),
        '[]',
      ],
    );
    return result.rows[0]!;
  } finally {
    client.release();
  }
}
