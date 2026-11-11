-- 005_delivery_acknowledgement: database-level enforcement of delivery semantics (architecture R4, "Delivery boundary").
-- Triggers only.
--
--   streamed_through  how far the server wrote the answer to the stream          (fixed when the message is stored)
--   rendered_through  how far the browser acknowledged rendering it              (only ever moves forward)
--   assertions.presented_at  set only for a sentence at or below rendered_through
--
-- so a sentence that was not acknowledged can never become "presented", whatever the application does.

-- Messages are stored unrendered, and an assistant message's streamed extent must lie within its sentences.
CREATE TRIGGER messages_start_unrendered BEFORE INSERT ON messages
WHEN NEW.rendered_through <> -1 OR NEW.last_ack_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'messages are stored unrendered'); END;

CREATE TRIGGER messages_streamed_in_range BEFORE INSERT ON messages
WHEN NEW.sentences_json IS NOT NULL
 AND (NEW.streamed_through IS NULL OR NEW.streamed_through < -1 OR NEW.streamed_through > json_array_length(NEW.sentences_json) - 1)
BEGIN SELECT RAISE(ABORT, 'streamed_through out of range'); END;

-- The browser cannot have rendered more than was streamed. (User messages have no streamed extent: they stay at -1.)
CREATE TRIGGER messages_rendered_within_streamed BEFORE UPDATE OF rendered_through ON messages
WHEN NEW.rendered_through > COALESCE(OLD.streamed_through, -1)
BEGIN SELECT RAISE(ABORT, 'cannot render beyond the streamed extent'); END;

-- Assertions are created unpresented, for a sentence that exists, in an assistant message of their own turn.
CREATE TRIGGER assertions_created_unpresented BEFORE INSERT ON assertions
WHEN NEW.presented_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'assertions are created unpresented'); END;

CREATE TRIGGER assertions_message_is_assistant_of_turn BEFORE INSERT ON assertions
WHEN (SELECT role FROM messages WHERE id = NEW.message_id) IS NOT 'assistant'
  OR (SELECT turn_id FROM messages WHERE id = NEW.message_id) IS NOT NEW.turn_id
BEGIN SELECT RAISE(ABORT, 'assertion must belong to an assistant message of its turn'); END;

CREATE TRIGGER assertions_sentence_exists BEFORE INSERT ON assertions
WHEN NEW.sentence_index < 0
  OR NEW.sentence_index > COALESCE((SELECT json_array_length(sentences_json) FROM messages WHERE id = NEW.message_id), 0) - 1
BEGIN SELECT RAISE(ABORT, 'assertion sentence_index out of range'); END;

-- The core delivery rule: presented only if the browser acknowledged that sentence.
CREATE TRIGGER assertions_presented_only_if_acknowledged BEFORE UPDATE OF presented_at ON assertions
WHEN NEW.presented_at IS NOT NULL
 AND NEW.sentence_index > (SELECT rendered_through FROM messages WHERE id = NEW.message_id)
BEGIN SELECT RAISE(ABORT, 'sentence has not been acknowledged as rendered'); END;

-- Status events: 'presented' follows an acknowledgement; 'not_presented' is only for sentences never streamed;
-- verdict events (reaffirmed, superseded, ...) describe a claim that was actually presented.
CREATE TRIGGER assertion_events_presented_needs_ack BEFORE INSERT ON assertion_events
WHEN NEW.status = 'presented' AND (SELECT presented_at FROM assertions WHERE id = NEW.assertion_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'presented event requires presented_at'); END;

CREATE TRIGGER assertion_events_not_presented_rules BEFORE INSERT ON assertion_events
WHEN NEW.status = 'not_presented' AND (
     (SELECT presented_at FROM assertions WHERE id = NEW.assertion_id) IS NOT NULL
  OR (SELECT a.sentence_index FROM assertions a WHERE a.id = NEW.assertion_id)
       <= COALESCE((SELECT m.streamed_through FROM messages m JOIN assertions a ON a.message_id = m.id WHERE a.id = NEW.assertion_id), -1)
)
BEGIN SELECT RAISE(ABORT, 'not_presented only for sentences that were never streamed'); END;

CREATE TRIGGER assertion_events_verdict_needs_presented BEFORE INSERT ON assertion_events
WHEN NEW.status NOT IN ('presented', 'not_presented')
 AND (SELECT presented_at FROM assertions WHERE id = NEW.assertion_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'verdict events apply to presented assertions only'); END;
