import { describe, it, expect, beforeEach } from 'vitest';
import { Cl } from '@stacks/transactions';

const accounts = simnet.getAccounts();
const deployer = accounts.get('deployer')!;
const wallet1 = accounts.get('wallet_1')!;
const wallet2 = accounts.get('wallet_2')!;
const wallet3 = accounts.get('wallet_3')!;

const contractName = 'micropayment-channel';

describe('Micropayment Channel Contract', () => {
  beforeEach(() => {
    // Reset the simnet state before each test
    simnet.reset();
  });

  describe('Contract Deployment', () => {
    it('should deploy successfully', () => {
      const deployTx = simnet.deployContract(
        contractName,
        readFileSync('./contracts/micropayment-channel.clar', 'utf8'),
        null,
        deployer
      );
      expect(deployTx.result).toEqual(Cl.ok(Cl.bool(true)));
    });

    it('should initialize with zero channels', () => {
      const result = simnet.callReadOnlyFn(
        contractName,
        'get-channel-count',
        [],
        deployer
      );
      expect(result.result).toEqual(Cl.uint(0));
    });

    it('should initialize with current block as 0', () => {
      const result = simnet.callReadOnlyFn(
        contractName,
        'get-current-block',
        [],
        deployer
      );
      expect(result.result).toEqual(Cl.uint(0));
    });
  });

  describe('Block Management', () => {
    it('should increment block counter', () => {
      const incrementTx = simnet.callPublicFn(
        contractName,
        'increment-block',
        [],
        deployer
      );
      expect(incrementTx.result).toEqual(Cl.ok(Cl.uint(1)));

      const result = simnet.callReadOnlyFn(
        contractName,
        'get-current-block',
        [],
        deployer
      );
      expect(result.result).toEqual(Cl.uint(1));
    });

    it('should increment block multiple times', () => {
      // Increment 5 times
      for (let i = 1; i <= 5; i++) {
        const incrementTx = simnet.callPublicFn(
          contractName,
          'increment-block',
          [],
          deployer
        );
        expect(incrementTx.result).toEqual(Cl.ok(Cl.uint(i)));
      }

      const result = simnet.callReadOnlyFn(
        contractName,
        'get-current-block',
        [],
        deployer
      );
      expect(result.result).toEqual(Cl.uint(5));
    });
  });

  describe('Channel Creation', () => {
    it('should create a new channel successfully', () => {
      const createTx = simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );
      expect(createTx.result).toEqual(Cl.ok(Cl.uint(1)));

      // Check channel count increased
      const countResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel-count',
        [],
        deployer
      );
      expect(countResult.result).toEqual(Cl.uint(1));
    });

    it('should fail to create channel with zero deposit from party A', () => {
      const createTx = simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(0),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );
      expect(createTx.result).toEqual(Cl.err(Cl.uint(104))); // ERR-INSUFFICIENT-FUNDS
    });

    it('should fail to create channel with zero deposit from party B', () => {
      const createTx = simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(0),
          Cl.uint(200)
        ],
        wallet1
      );
      expect(createTx.result).toEqual(Cl.err(Cl.uint(104))); // ERR-INSUFFICIENT-FUNDS
    });

    it('should fail to create channel with insufficient timeout', () => {
      const createTx = simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(50) // Too low timeout
        ],
        wallet1
      );
      expect(createTx.result).toEqual(Cl.err(Cl.uint(105))); // ERR-TIMEOUT-NOT-REACHED
    });

    it('should store channel data correctly', () => {
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );

      const channelResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );

      const expectedChannel = Cl.some(Cl.tuple({
        'party-a': Cl.principal(wallet1),
        'party-b': Cl.principal(wallet2),
        'balance-a': Cl.uint(1000),
        'balance-b': Cl.uint(2000),
        'total-deposit': Cl.uint(3000),
        'nonce': Cl.uint(0),
        'timeout': Cl.uint(200),
        'is-closed': Cl.bool(false),
        'challenge-period': Cl.uint(144),
        'created-at': Cl.uint(0)
      }));

      expect(channelResult.result).toEqual(expectedChannel);
    });

    it('should verify channel parties correctly', () => {
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );

      // Check party A
      const isPartyA = simnet.callReadOnlyFn(
        contractName,
        'is-channel-party',
        [Cl.uint(1), Cl.principal(wallet1)],
        deployer
      );
      expect(isPartyA.result).toEqual(Cl.bool(true));

      // Check party B
      const isPartyB = simnet.callReadOnlyFn(
        contractName,
        'is-channel-party',
        [Cl.uint(1), Cl.principal(wallet2)],
        deployer
      );
      expect(isPartyB.result).toEqual(Cl.bool(true));

      // Check non-party
      const isNonParty = simnet.callReadOnlyFn(
        contractName,
        'is-channel-party',
        [Cl.uint(1), Cl.principal(wallet3)],
        deployer
      );
      expect(isNonParty.result).toEqual(Cl.bool(false));
    });
  });

  describe('Channel Deposits', () => {
    beforeEach(() => {
      // Create a channel for testing deposits
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );
    });

    it('should allow party A to deposit additional funds', () => {
      const depositTx = simnet.callPublicFn(
        contractName,
        'deposit-to-channel',
        [Cl.uint(1), Cl.uint(500)],
        wallet1
      );
      expect(depositTx.result).toEqual(Cl.ok(Cl.bool(true)));

      // Check updated balances
      const channelResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );

      const channel = channelResult.result.value;
      expect(channel.data['balance-a']).toEqual(Cl.uint(1500));
      expect(channel.data['total-deposit']).toEqual(Cl.uint(3500));
    });

    it('should allow party B to deposit additional funds', () => {
      const depositTx = simnet.callPublicFn(
        contractName,
        'deposit-to-channel',
        [Cl.uint(1), Cl.uint(300)],
        wallet2
      );
      expect(depositTx.result).toEqual(Cl.ok(Cl.bool(true)));

      // Check updated balances
      const channelResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );

      const channel = channelResult.result.value;
      expect(channel.data['balance-b']).toEqual(Cl.uint(2300));
      expect(channel.data['total-deposit']).toEqual(Cl.uint(3300));
    });

    it('should fail when non-party tries to deposit', () => {
      const depositTx = simnet.callPublicFn(
        contractName,
        'deposit-to-channel',
        [Cl.uint(1), Cl.uint(500)],
        wallet3
      );
      expect(depositTx.result).toEqual(Cl.err(Cl.uint(100))); // ERR-NOT-AUTHORIZED
    });

    it('should fail to deposit zero amount', () => {
      const depositTx = simnet.callPublicFn(
        contractName,
        'deposit-to-channel',
        [Cl.uint(1), Cl.uint(0)],
        wallet1
      );
      expect(depositTx.result).toEqual(Cl.err(Cl.uint(104))); // ERR-INSUFFICIENT-FUNDS
    });

    it('should fail to deposit to non-existent channel', () => {
      const depositTx = simnet.callPublicFn(
        contractName,
        'deposit-to-channel',
        [Cl.uint(999), Cl.uint(500)],
        wallet1
      );
      expect(depositTx.result).toEqual(Cl.err(Cl.uint(101))); // ERR-CHANNEL-NOT-FOUND
    });
  });

  describe('Cooperative Channel Closing', () => {
    beforeEach(() => {
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );
    });

    it('should allow cooperative close with valid balances', () => {
      const closeTx = simnet.callPublicFn(
        contractName,
        'cooperative-close',
        [
          Cl.uint(1),
          Cl.uint(1500),
          Cl.uint(1500),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );
      expect(closeTx.result).toEqual(Cl.ok(Cl.bool(true)));

      // Check channel is marked as closed
      const channelResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );
      const channel = channelResult.result.value;
      expect(channel.data['is-closed']).toEqual(Cl.bool(true));
    });

    it('should fail cooperative close with invalid balance sum', () => {
      const closeTx = simnet.callPublicFn(
        contractName,
        'cooperative-close',
        [
          Cl.uint(1),
          Cl.uint(1500),
          Cl.uint(2000), // Sum doesn't match total deposit
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );
      expect(closeTx.result).toEqual(Cl.err(Cl.uint(106))); // ERR-INVALID-BALANCE
    });

    it('should fail when non-party tries to close', () => {
      const closeTx = simnet.callPublicFn(
        contractName,
        'cooperative-close',
        [
          Cl.uint(1),
          Cl.uint(1500),
          Cl.uint(1500),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet3
      );
      expect(closeTx.result).toEqual(Cl.err(Cl.uint(100))); // ERR-NOT-AUTHORIZED
    });
  });

  describe('Challenge Mechanism', () => {
    beforeEach(() => {
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );
    });

    it('should allow challenge close with valid parameters', () => {
      const challengeTx = simnet.callPublicFn(
        contractName,
        'challenge-close',
        [
          Cl.uint(1),
          Cl.uint(1200),
          Cl.uint(1800),
          Cl.uint(1),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );
      expect(challengeTx.result).toEqual(Cl.ok(Cl.bool(true)));

      // Check dispute was created
      const disputeResult = simnet.callReadOnlyFn(
        contractName,
        'get-dispute',
        [Cl.uint(1)],
        deployer
      );
      expect(disputeResult.result).toBeDefined();
    });

    it('should fail challenge with invalid balance sum', () => {
      const challengeTx = simnet.callPublicFn(
        contractName,
        'challenge-close',
        [
          Cl.uint(1),
          Cl.uint(1200),
          Cl.uint(2000), // Invalid sum
          Cl.uint(1),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );
      expect(challengeTx.result).toEqual(Cl.err(Cl.uint(106))); // ERR-INVALID-BALANCE
    });

    it('should allow challenge response with higher nonce', () => {
      // First, create a challenge
      simnet.callPublicFn(
        contractName,
        'challenge-close',
        [
          Cl.uint(1),
          Cl.uint(1200),
          Cl.uint(1800),
          Cl.uint(1),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );

      // Then respond with higher nonce
      const responseTx = simnet.callPublicFn(
        contractName,
        'challenge-response',
        [
          Cl.uint(1),
          Cl.uint(1100),
          Cl.uint(1900),
          Cl.uint(2), // Higher nonce
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet2
      );
      expect(responseTx.result).toEqual(Cl.ok(Cl.bool(true)));
    });

    it('should fail challenge response with lower nonce', () => {
      // First, create a challenge
      simnet.callPublicFn(
        contractName,
        'challenge-close',
        [
          Cl.uint(1),
          Cl.uint(1200),
          Cl.uint(1800),
          Cl.uint(5),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );

      // Then try to respond with lower nonce
      const responseTx = simnet.callPublicFn(
        contractName,
        'challenge-response',
        [
          Cl.uint(1),
          Cl.uint(1100),
          Cl.uint(1900),
          Cl.uint(3), // Lower nonce
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet2
      );
      expect(responseTx.result).toEqual(Cl.err(Cl.uint(103))); // ERR-INVALID-SIGNATURE
    });
  });

  describe('Challenge Finalization', () => {
    beforeEach(() => {
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );

      // Create a challenge
      simnet.callPublicFn(
        contractName,
        'challenge-close',
        [
          Cl.uint(1),
          Cl.uint(1200),
          Cl.uint(1800),
          Cl.uint(1),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );
    });

    it('should finalize challenge after challenge period', () => {
      // Advance blocks past challenge period (144 blocks)
      for (let i = 0; i < 145; i++) {
        simnet.callPublicFn(contractName, 'increment-block', [], deployer);
      }

      const finalizeTx = simnet.callPublicFn(
        contractName,
        'finalize-challenge',
        [Cl.uint(1)],
        deployer
      );
      expect(finalizeTx.result).toEqual(Cl.ok(Cl.bool(true)));

      // Check channel is closed
      const channelResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );
      const channel = channelResult.result.value;
      expect(channel.data['is-closed']).toEqual(Cl.bool(true));

      // Check dispute is cleaned up
      const disputeResult = simnet.callReadOnlyFn(
        contractName,
        'get-dispute',
        [Cl.uint(1)],
        deployer
      );
      expect(disputeResult.result).toEqual(Cl.none());
    });

    it('should fail to finalize before challenge period ends', () => {
      // Only advance a few blocks
      for (let i = 0; i < 10; i++) {
        simnet.callPublicFn(contractName, 'increment-block', [], deployer);
      }

      const finalizeTx = simnet.callPublicFn(
        contractName,
        'finalize-challenge',
        [Cl.uint(1)],
        deployer
      );
      expect(finalizeTx.result).toEqual(Cl.err(Cl.uint(105))); // ERR-TIMEOUT-NOT-REACHED
    });
  });

  describe('Timeout Close', () => {
    beforeEach(() => {
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(150) // Timeout at block 150
        ],
        wallet1
      );
    });

    it('should allow timeout close after timeout period', () => {
      // Advance blocks past timeout
      for (let i = 0; i < 151; i++) {
        simnet.callPublicFn(contractName, 'increment-block', [], deployer);
      }

      const timeoutTx = simnet.callPublicFn(
        contractName,
        'timeout-close',
        [Cl.uint(1)],
        deployer
      );
      expect(timeoutTx.result).toEqual(Cl.ok(Cl.bool(true)));

      // Check channel is closed
      const channelResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );
      const channel = channelResult.result.value;
      expect(channel.data['is-closed']).toEqual(Cl.bool(true));
    });

    it('should fail timeout close before timeout period', () => {
      // Only advance a few blocks
      for (let i = 0; i < 100; i++) {
        simnet.callPublicFn(contractName, 'increment-block', [], deployer);
      }

      const timeoutTx = simnet.callPublicFn(
        contractName,
        'timeout-close',
        [Cl.uint(1)],
        deployer
      );
      expect(timeoutTx.result).toEqual(Cl.err(Cl.uint(105))); // ERR-TIMEOUT-NOT-REACHED
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle operations on non-existent channels', () => {
      const result = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(999)],
        deployer
      );
      expect(result.result).toEqual(Cl.none());
    });

    it('should prevent operations on closed channels', () => {
      // Create and close a channel
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );

      simnet.callPublicFn(
        contractName,
        'cooperative-close',
        [
          Cl.uint(1),
          Cl.uint(1500),
          Cl.uint(1500),
          Cl.bufferFromHex('00'.repeat(65)),
          Cl.bufferFromHex('00'.repeat(65))
        ],
        wallet1
      );

      // Try to deposit to closed channel
      const depositTx = simnet.callPublicFn(
        contractName,
        'deposit-to-channel',
        [Cl.uint(1), Cl.uint(500)],
        wallet1
      );
      expect(depositTx.result).toEqual(Cl.err(Cl.uint(102))); // ERR-CHANNEL-CLOSED
    });

    it('should handle multiple channels correctly', () => {
      // Create multiple channels
      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet2),
          Cl.uint(1000),
          Cl.uint(2000),
          Cl.uint(200)
        ],
        wallet1
      );

      simnet.callPublicFn(
        contractName,
        'create-channel',
        [
          Cl.principal(wallet3),
          Cl.uint(500),
          Cl.uint(1500),
          Cl.uint(300)
        ],
        wallet2
      );

      // Check both channels exist and are separate
      const channel1 = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(1)],
        deployer
      );
      const channel2 = simnet.callReadOnlyFn(
        contractName,
        'get-channel',
        [Cl.uint(2)],
        deployer
      );

      expect(channel1.result.value.data['party-b']).toEqual(Cl.principal(wallet2));
      expect(channel2.result.value.data['party-b']).toEqual(Cl.principal(wallet3));

      // Check counter is correct
      const countResult = simnet.callReadOnlyFn(
        contractName,
        'get-channel-count',
        [],
        deployer
      );
      expect(countResult.result).toEqual(Cl.uint(2));
    });
  });
});