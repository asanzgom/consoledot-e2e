import { test, expect } from '@playwright/test';
import login from '@lib/auth';
import { config } from '@lib/config';
import {
  deleteKafkaInstance,
  createKafkaInstance,
  getBootstrapUrl,
  navigateToAccess,
  navigateToConsumerGroups,
  grantProducerAccess,
  grantConsumerAccess,
  waitForKafkaReady,
  deleteAllKafkas
} from '@lib/kafka';
import { navigateToKafkaTopicsList, createKafkaTopic, navigateToMessages, refreshMessages } from '@lib/topic';
import { KafkaConsumer, KafkaProducer } from '@lib/clients';
import { createServiceAccount, deleteAllServiceAccounts, deleteServiceAccount, navigateToSAList } from '@lib/sa';
import { retry } from '@lib/common';
import {
  Limit,
  filterMessagesByOffset,
  FilterGroup,
  pickFilterOption,
  applyFilter,
  setPartition,
  setTimestamp,
  setEpoch,
  setLimit
} from '@lib/messages';
import { navigateToKafkaList } from '@lib/navigation';

const testInstanceName = config.instanceName;
const testTopicName = `test-topic-name-${config.sessionID}`;
const testServiceAccountName = `test-messaging-sa-${config.sessionID}`;
const testMessageKey = 'key';
const consumerGroupId = `test-consumer-group-${config.sessionID}`;
const expectedMessageCount = 100;
const reconnectCount = 5;
const reconnectDelayMs = 500;
let credentials;
let bootstrap: string;

test.beforeEach(async ({ page }) => {
  await login(page);

  await navigateToKafkaList(page);

  await expect(page.getByRole('button', { name: 'Create Kafka instance' })).toBeVisible();

  if ((await page.getByText(testInstanceName).count()) > 0 && (await page.locator('tr').count()) === 2) {
    // Test instance present, nothing to do!
  } else {
    await page.waitForSelector('[role=progressbar]', {
      state: 'detached',
      timeout: config.kafkaInstanceCreationTimeout
    });

    for (const el of await page.locator(`tr >> a`).elementHandles()) {
      const name = await el.textContent();

      if (name !== testInstanceName) {
        await deleteKafkaInstance(page, name);
      }
    }

    if ((await page.getByText(testInstanceName).count()) === 0) {
      await createKafkaInstance(page, testInstanceName);
      await waitForKafkaReady(page, testInstanceName);
    }
  }

  await navigateToKafkaTopicsList(page, testInstanceName);
  // Do not create topic if it already exists
  await expect(page.getByText('Create topic')).toHaveCount(1);
  await expect(page.getByText('Loading content')).toHaveCount(0);
  if ((await page.locator('a', { hasText: testTopicName }).count()) === 0) {
    await createKafkaTopic(page, testTopicName, true);
  }

  await navigateToSAList(page);
  await expect(page.getByText('Create service account')).toHaveCount(1);
  credentials = await createServiceAccount(page, testServiceAccountName);
  bootstrap = await getBootstrapUrl(page, testInstanceName);

  await navigateToAccess(page, testInstanceName);
  await grantProducerAccess(page, credentials.clientID, testTopicName);

  // Producer 100 messages
  const producer = new KafkaProducer(bootstrap, credentials.clientID, credentials.clientSecret);
  const producerResponse = await retry(
    () => producer.produceMessages(testTopicName, expectedMessageCount, testMessageKey),
    reconnectCount,
    reconnectDelayMs
  );
  expect(producerResponse === true).toBeTruthy();
});

test.afterEach(async ({ page }) => {
  await deleteAllServiceAccounts(page);
});

test.afterAll(async ({ page }) => {
  await deleteAllServiceAccounts(page);
  await deleteAllKafkas(page);
});

// test_6messages.py generate_messages_to_topic
test('Consume messages from topic', async ({ page }) => {
  await navigateToAccess(page, testInstanceName);
  await grantConsumerAccess(page, credentials.clientID, testTopicName, consumerGroupId);

  // Consume 100 messages
  const consumer = new KafkaConsumer(bootstrap, consumerGroupId, credentials.clientID, credentials.clientSecret);
  const consumerResponse = await retry(
    () => consumer.consumeMessages(testTopicName, expectedMessageCount),
    reconnectCount,
    reconnectDelayMs
  );
  expect(consumerResponse).toEqual(expectedMessageCount);

  // Open Consumer Groups Tab to check dashboard
  await navigateToConsumerGroups(page);
  await expect(await page.getByText(consumerGroupId)).toHaveCount(1);
});

// test_6messages.py browse_messages
test('Browse messages', async ({ page }) => {
  await navigateToMessages(page, testInstanceName, testTopicName);

  await refreshMessages(page);

  await expect(page.locator('table[aria-label="Messages table"]')).toContainText('value-' + testMessageKey);
  await expect(page.locator('table[aria-label="Messages table"]')).toContainText('key-' + testMessageKey);
  await page.locator('table[aria-label="Messages table"] >> tr').nth(1).click();
  const messageDetail = await page.locator('data-testid=message-details');
  await expect(messageDetail.locator('dt:has-text("Offset")')).toHaveCount(1);
  await expect(messageDetail.locator('dd:has-text("key-")')).toHaveCount(1);
});

const filters = [FilterGroup.offset, FilterGroup.timestamp, FilterGroup.epoch, FilterGroup.latest];
for (const filter of filters) {
  test(`Filter messages by ${filter}`, async ({ page }) => {
    // Today and tomorrow date
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);

    await navigateToMessages(page, testInstanceName, testTopicName);

    await refreshMessages(page);
    const messageTable = page.locator('table[aria-label="Messages table"] >> tbody >> tr');

    switch (filter) {
      case FilterGroup.offset: {
        await pickFilterOption(page, FilterGroup.offset);
        await filterMessagesByOffset(page, '0', '20', Limit.ten);

        // Check that 1st message has offset 20
        await messageTable.nth(0).locator('td[data-label="Offset"]');
        await expect(messageTable.nth(0).locator('td[data-label="Offset"]')).toContainText('20');
        // Check size of the table
        await expect(await messageTable.count()).toBe(Limit.ten);

        // Set offset to 13 and limit to 50
        await filterMessagesByOffset(page, '0', '13', Limit.fifty);
        // messageTable = await page.locator('table[aria-label="Messages table"] >> tbody >> tr');

        // Check that 1st message has offset 13
        await expect(messageTable.nth(0).locator('td[data-label="Offset"]')).toContainText('13');
        await expect(await messageTable.count()).toBe(Limit.fifty);
        break;
      }
      case FilterGroup.timestamp: {
        // Skip FilterByTimestamp test meanwhile there is reported Bug https://issues.redhat.com/browse/MGDSTRM-10574
        test.skip();
        await pickFilterOption(page, FilterGroup.timestamp);
        await setTimestamp(page, today.toISOString().slice(0, 10));
        await applyFilter(page);
        // Check that messages are in the table
        await expect(await messageTable.count()).toBeGreaterThan(0);

        // Set epoch timestam to tomorrow and check that table is empty
        await setTimestamp(page, tomorrow.toISOString().slice(0, 10));
        await applyFilter(page);
        await expect(await page.getByText('No messages data')).toHaveCount(1);
        // await expectMessageTableIsEmpty(page);
        await expect(messageTable).toHaveCount(1);
        break;
      }
      case FilterGroup.epoch: {
        await pickFilterOption(page, FilterGroup.epoch);
        await setEpoch(page, today.getTime());
        await applyFilter(page);
        // Check that messages are in the table
        await expect(await messageTable.count()).toBeGreaterThan(0);

        // Set epoch timestam to tomorrow and check that table is empty
        // Tomorrow's epoch doesn't work -> https://issues.redhat.com/browse/MGDX-294
        // await setEpoch(page, tomorrow.getTime());
        // await applyFilter(page);
        // await expect(await page.getByText("No messages data")).toHaveCount(1)
        // await expectMessageTableIsEmpty(page)
        break;
      }
      case FilterGroup.latest: {
        await pickFilterOption(page, FilterGroup.latest);
        await setPartition(page, '0');
        await setLimit(page, Limit.twenty);
        await applyFilter(page);
        await expect(await messageTable.count()).toBeGreaterThan(0);
        break;
      }
    }
  });
}
// test_6acl.py test_kafka_create_consumer_group_and_check_dashboard
test('create consumer group and check dashboard', async ({ page }) => {
  const instanceLinkSelector = page.getByText(testInstanceName);
  const row = page.locator('tr', { has: instanceLinkSelector });

  await navigateToKafkaList(page);
  await row.locator('[aria-label="Actions"]').click();
  await page.getByText('Connection').click();

  const bootstrapUrl = await getBootstrapUrl(page, testInstanceName);
  console.log('bootstrapUrl: ' + bootstrapUrl);

  // Consumer
  await navigateToAccess(page, testInstanceName);
  await grantConsumerAccess(page, credentials.clientID, testTopicName, consumerGroupId);
  const consumer = new KafkaConsumer(bootstrapUrl, consumerGroupId, credentials.clientID, credentials.clientSecret);
  const consumerResponse = await retry(
    () => consumer.consumeMessages(testTopicName, expectedMessageCount),
    reconnectCount,
    reconnectDelayMs
  );
  expect(consumerResponse).toEqual(expectedMessageCount);

  // Open Consumer Groups Tab to check dashboard
  await navigateToConsumerGroups(page);
  await expect(page.getByText(consumerGroupId)).toHaveCount(1);

  await navigateToSAList(page);
  await deleteServiceAccount(page, testServiceAccountName);
});
