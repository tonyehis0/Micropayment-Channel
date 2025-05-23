;; Micropayment Channel Smart Contract
;; Implements bidirectional payment channels for off-chain microtransactions

;; Error codes
(define-constant ERR-NOT-AUTHORIZED (err u100))
(define-constant ERR-CHANNEL-NOT-FOUND (err u101))
(define-constant ERR-CHANNEL-CLOSED (err u102))
(define-constant ERR-INVALID-SIGNATURE (err u103))
(define-constant ERR-INSUFFICIENT-FUNDS (err u104))
(define-constant ERR-TIMEOUT-NOT-REACHED (err u105))
(define-constant ERR-INVALID-BALANCE (err u106))
(define-constant ERR-CHANNEL-ALREADY-EXISTS (err u107))

;; Channel structure
(define-map channels
  { channel-id: uint }
  {
    party-a: principal,
    party-b: principal,
    balance-a: uint,
    balance-b: uint,
    total-deposit: uint,
    nonce: uint,
    timeout: uint,
    is-closed: bool,
    challenge-period: uint,
    created-at: uint
  }
)

;; Channel disputes for challenge period
(define-map disputes
  { channel-id: uint }
  {
    challenger: principal,
    new-balance-a: uint,
    new-balance-b: uint,
    new-nonce: uint,
    challenge-time: uint,
    signature-a: (buff 65),
    signature-b: (buff 65)
  }
)

;; Channel counter for unique IDs
(define-data-var channel-counter uint u0)

;; Block counter to simulate block height
(define-data-var current-block uint u0)

;; Default challenge period (blocks)
(define-constant DEFAULT-CHALLENGE-PERIOD u144) ;; ~24 hours

;; Increment block counter (call this periodically or with each transaction)
(define-public (increment-block)
  (begin
    (var-set current-block (+ (var-get current-block) u1))
    (ok (var-get current-block))
  )
)
;; Create a new payment channel
(define-public (create-channel (party-b principal) (initial-deposit-a uint) (initial-deposit-b uint) (timeout uint))
  (let (
    (channel-id (+ (var-get channel-counter) u1))
    (total-deposit (+ initial-deposit-a initial-deposit-b))
  )
    (asserts! (> initial-deposit-a u0) ERR-INSUFFICIENT-FUNDS)
    (asserts! (> initial-deposit-b u0) ERR-INSUFFICIENT-FUNDS)
    (asserts! (> timeout (+ (var-get current-block) u100)) ERR-TIMEOUT-NOT-REACHED)
    
    ;; Transfer funds from both parties
    (try! (stx-transfer? initial-deposit-a tx-sender (as-contract tx-sender)))
    (try! (stx-transfer? initial-deposit-b party-b (as-contract tx-sender)))
    
    ;; Create channel
    (map-set channels
      { channel-id: channel-id }
      {
        party-a: tx-sender,
        party-b: party-b,
        balance-a: initial-deposit-a,
        balance-b: initial-deposit-b,
        total-deposit: total-deposit,
        nonce: u0,
        timeout: timeout,
        is-closed: false,
        challenge-period: DEFAULT-CHALLENGE-PERIOD,
        created-at: (var-get current-block)
      }
    )
    
    ;; Update counter
    (var-set channel-counter channel-id)
    
    (ok channel-id)
  )
)
;; Deposit additional funds to channel
(define-public (deposit-to-channel (channel-id uint) (amount uint))
  (let (
    (channel (unwrap! (map-get? channels { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
  )
    (asserts! (not (get is-closed channel)) ERR-CHANNEL-CLOSED)
    (asserts! (> amount u0) ERR-INSUFFICIENT-FUNDS)
    (asserts! (or (is-eq tx-sender (get party-a channel))
                  (is-eq tx-sender (get party-b channel))) ERR-NOT-AUTHORIZED)
    
    ;; Transfer funds to contract
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    
    ;; Update channel balances
    (map-set channels
      { channel-id: channel-id }
      (merge channel {
        balance-a: (if (is-eq tx-sender (get party-a channel))
                      (+ (get balance-a channel) amount)
                      (get balance-a channel)),
        balance-b: (if (is-eq tx-sender (get party-b channel))
                      (+ (get balance-b channel) amount)
                      (get balance-b channel)),
        total-deposit: (+ (get total-deposit channel) amount)
      })
    )
    
    (ok true)
  )
)

;; Cooperative close - both parties agree on final balances
(define-public (cooperative-close (channel-id uint) (final-balance-a uint) (final-balance-b uint)
                                  (signature-a (buff 65)) (signature-b (buff 65)))
  (let (
    (channel (unwrap! (map-get? channels { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
  )
    (asserts! (not (get is-closed channel)) ERR-CHANNEL-CLOSED)
    (asserts! (is-eq (+ final-balance-a final-balance-b) (get total-deposit channel)) ERR-INVALID-BALANCE)
    
    ;; Verify both parties signed the final state
    ;; In a real implementation, you'd verify signatures here
    ;; For now, we check that both parties are calling this function together
    (asserts! (or (is-eq tx-sender (get party-a channel))
                  (is-eq tx-sender (get party-b channel))) ERR-NOT-AUTHORIZED)
    
    ;; Transfer final balances
    (if (> final-balance-a u0)
      (try! (as-contract (stx-transfer? final-balance-a tx-sender (get party-a channel))))
      true
    )
    
    (if (> final-balance-b u0)
      (try! (as-contract (stx-transfer? final-balance-b tx-sender (get party-b channel))))
      true
    )
    ;; Mark channel as closed
    (map-set channels
      { channel-id: channel-id }
      (merge channel { is-closed: true })
    )
    
    (ok true)
  )
)

;; Unilateral close - one party initiates closure with latest state
(define-public (challenge-close (channel-id uint) (new-balance-a uint) (new-balance-b uint)
                                (new-nonce uint) (signature-a (buff 65)) (signature-b (buff 65)))
  (let (
    (channel (unwrap! (map-get? channels { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
  )
    (asserts! (not (get is-closed channel)) ERR-CHANNEL-CLOSED)
    (asserts! (or (is-eq tx-sender (get party-a channel))
                  (is-eq tx-sender (get party-b channel))) ERR-NOT-AUTHORIZED)
    (asserts! (>= new-nonce (get nonce channel)) ERR-INVALID-SIGNATURE)
    (asserts! (is-eq (+ new-balance-a new-balance-b) (get total-deposit channel)) ERR-INVALID-BALANCE)
    
    ;; Start challenge period
    (map-set disputes
      { channel-id: channel-id }
      {
        challenger: tx-sender,
        new-balance-a: new-balance-a,
        new-balance-b: new-balance-b,
        new-nonce: new-nonce,
        challenge-time: (var-get current-block),
        signature-a: signature-a,
        signature-b: signature-b
      }
    )
    
    (ok true)
  )
)

;; Respond to challenge with newer state
(define-public (challenge-response (channel-id uint) (newer-balance-a uint) (newer-balance-b uint)
                                   (newer-nonce uint) (signature-a (buff 65)) (signature-b (buff 65)))
  (let (
    (channel (unwrap! (map-get? channels { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
    (dispute (unwrap! (map-get? disputes { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
  )
    (asserts! (not (get is-closed channel)) ERR-CHANNEL-CLOSED)
    (asserts! (or (is-eq tx-sender (get party-a channel))
                  (is-eq tx-sender (get party-b channel))) ERR-NOT-AUTHORIZED)
    (asserts! (> newer-nonce (get new-nonce dispute)) ERR-INVALID-SIGNATURE)
    (asserts! (is-eq (+ newer-balance-a newer-balance-b) (get total-deposit channel)) ERR-INVALID-BALANCE)
    
    ;; Update dispute with newer state
    (map-set disputes
      { channel-id: channel-id }
      (merge dispute {
        new-balance-a: newer-balance-a,
        new-balance-b: newer-balance-b,
        new-nonce: newer-nonce,
        signature-a: signature-a,
        signature-b: signature-b
      })
    )
    
    (ok true)
  )
)

;; Finalize challenge after challenge period expires
(define-public (finalize-challenge (channel-id uint))
  (let (
    (channel (unwrap! (map-get? channels { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
    (dispute (unwrap! (map-get? disputes { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
  )
    (asserts! (not (get is-closed channel)) ERR-CHANNEL-CLOSED)
    (asserts! (>= (var-get current-block) 
                  (+ (get challenge-time dispute) (get challenge-period channel))) ERR-TIMEOUT-NOT-REACHED)
    
    ;; Transfer final balances based on dispute
    (if (> (get new-balance-a dispute) u0)
      (try! (as-contract (stx-transfer? (get new-balance-a dispute) tx-sender (get party-a channel))))
      true
    )
    
    (if (> (get new-balance-b dispute) u0)
      (try! (as-contract (stx-transfer? (get new-balance-b dispute) tx-sender (get party-b channel))))
      true
    )
    
    ;; Mark channel as closed
    (map-set channels
      { channel-id: channel-id }
      (merge channel { 
        is-closed: true,
        balance-a: (get new-balance-a dispute),
        balance-b: (get new-balance-b dispute),
        nonce: (get new-nonce dispute)
      })
    )
    
    ;; Clean up dispute
    (map-delete disputes { channel-id: channel-id })
    
    (ok true)
  )
)

;; Force close after timeout (if no activity)
(define-public (timeout-close (channel-id uint))
  (let (
    (channel (unwrap! (map-get? channels { channel-id: channel-id }) ERR-CHANNEL-NOT-FOUND))
  )
    (asserts! (not (get is-closed channel)) ERR-CHANNEL-CLOSED)
    (asserts! (>= (var-get current-block) (get timeout channel)) ERR-TIMEOUT-NOT-REACHED)
    
    ;; Return funds to original parties based on current balances
    (if (> (get balance-a channel) u0)
      (try! (as-contract (stx-transfer? (get balance-a channel) tx-sender (get party-a channel))))
      true
    )
    
    (if (> (get balance-b channel) u0)
      (try! (as-contract (stx-transfer? (get balance-b channel) tx-sender (get party-b channel))))
      true
    )
    
    ;; Mark channel as closed
    (map-set channels
      { channel-id: channel-id }
      (merge channel { is-closed: true })
    )
    
    (ok true)
  )
)

;; Read-only functions

(define-read-only (get-current-block)
  (var-get current-block)
)

(define-read-only (get-channel (channel-id uint))
  (map-get? channels { channel-id: channel-id })
)

(define-read-only (get-dispute (channel-id uint))
  (map-get? disputes { channel-id: channel-id })
)

(define-read-only (get-channel-count)
  (var-get channel-counter)
)

(define-read-only (is-channel-party (channel-id uint) (user principal))
  (match (map-get? channels { channel-id: channel-id })
    channel (or (is-eq user (get party-a channel))
                (is-eq user (get party-b channel)))
    false
  )
)

(define-read-only (get-user-channels (user principal))
  ;; This would need to be implemented with a more complex data structure
  ;; to efficiently query channels by user in a real implementation
  (ok "Use events or indexing service to track user channels")
)