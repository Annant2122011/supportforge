import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import {
  createKnowledgeArticle,
  getKnowledgeArticle,
  recordKnowledgeArticleFeedback,
  searchKnowledgeBase,
  setKnowledgeArticleStatus,
  updateKnowledgeArticle,
  type KnowledgeAccess,
} from '../src/services/knowledgeBaseService';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);
const isLocalPostgres = /@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(process.env.DATABASE_URL ?? '');
const integrationEnabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error('Refusing Knowledge Base integration tests against a non-local database.');
}

test('Knowledge Base persistence enforces stale revisions, publication, and article access gates', { skip: !integrationEnabled }, async () => {
  await migratePostgres();
  const pool = getPostgresPool();
  const guildId = 'stage4-kb-' + randomUUID();
  const actorId = 'stage4-test-admin';
  const roleId = '12345678901234567';
  const visitor: KnowledgeAccess = { isAdmin: false, isStaff: false, roleIds: [] };
  const staffWithoutAllowedRole: KnowledgeAccess = { isAdmin: false, isStaff: true, roleIds: ['12345678901234568'] };
  const allowedRole: KnowledgeAccess = { isAdmin: false, isStaff: true, roleIds: [roleId] };
  const admin: KnowledgeAccess = { isAdmin: true, isStaff: true, roleIds: [] };
  const suffix = guildId.slice(-8);

  try {
    const publicArticle = await createKnowledgeArticle(guildId, actorId, {
      title: 'Billing verification ' + suffix,
      summary: 'Customer billing timing and refund status',
      body: 'Billing requests are reviewed by the support team. VerificationTokenBlue',
      category: 'Billing',
      tags: ['billing', 'refund'],
    });
    assert.equal(publicArticle.status, 'draft');
    assert.equal(publicArticle.revision, 1);
    assert.equal(await getKnowledgeArticle(guildId, publicArticle.id, visitor), null);

    const edited = await updateKnowledgeArticle(guildId, publicArticle.id, 1, actorId, {
      body: 'Updated billing guidance. VerificationTokenBlue',
    });
    assert.equal(edited.revision, 2);
    await assert.rejects(
      updateKnowledgeArticle(guildId, publicArticle.id, 1, actorId, { body: 'stale overwrite' }),
      /changed since it was opened/,
    );

    const published = await setKnowledgeArticleStatus(guildId, publicArticle.id, 2, actorId, 'published');
    assert.equal(published.status, 'published');
    assert.equal(published.revision, 3);
    assert.equal((await getKnowledgeArticle(guildId, publicArticle.id, visitor))?.revision, 3);

    const staffArticle = await createKnowledgeArticle(guildId, actorId, {
      title: 'Staff escalation ' + suffix,
      body: 'Private staff escalation process VerificationTokenBlue',
      visibility: 'staff',
    });
    await setKnowledgeArticleStatus(guildId, staffArticle.id, 1, actorId, 'published');
    assert.equal(await getKnowledgeArticle(guildId, staffArticle.id, visitor), null);
    assert.ok(await getKnowledgeArticle(guildId, staffArticle.id, staffWithoutAllowedRole));

    const restrictedArticle = await createKnowledgeArticle(guildId, actorId, {
      title: 'Role restricted refund ' + suffix,
      body: 'Refund process with limited staff visibility VerificationTokenBlue',
      visibility: 'public',
      allowedRoleIds: [roleId],
    });
    await setKnowledgeArticleStatus(guildId, restrictedArticle.id, 1, actorId, 'published');
    assert.equal(await getKnowledgeArticle(guildId, restrictedArticle.id, visitor), null);
    assert.equal(await getKnowledgeArticle(guildId, restrictedArticle.id, staffWithoutAllowedRole), null);
    assert.ok(await getKnowledgeArticle(guildId, restrictedArticle.id, allowedRole));
    assert.ok(await getKnowledgeArticle(guildId, restrictedArticle.id, admin));

    const visitorResults = await searchKnowledgeBase(guildId, 'billing refund verification', visitor, 'stage4-test-visitor');
    assert.ok(visitorResults.some((article) => article.id === publicArticle.id));
    assert.ok(!visitorResults.some((article) => article.id === staffArticle.id));
    assert.ok(!visitorResults.some((article) => article.id === restrictedArticle.id));

    await recordKnowledgeArticleFeedback(guildId, publicArticle.id, 'stage4-test-visitor', visitor, true);
    await assert.rejects(
      recordKnowledgeArticleFeedback(guildId, publicArticle.id, 'stage4-test-visitor', visitor, false),
      /already rated this article/,
    );
  } finally {
    await pool.query('DELETE FROM knowledge_base_articles WHERE guild_id=$1', [guildId]);
    await pool.query('DELETE FROM knowledge_base_synonyms WHERE guild_id=$1', [guildId]);
    await closePostgresDatabase();
  }
});
