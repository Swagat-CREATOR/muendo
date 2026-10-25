// §36.6 U5: what of an act may leave the proxy. CLAUDE.md rule 4 and this crate's first rule: a password field's
// text is never shown and never logged.
//
// The proxy cannot know whether the field under the point is a password field: that takes a UI Automation lookup,
// which belongs to the core and is not built (lib.rs, "What it does not do"). So it assumes every typed text might
// be one, and nothing typed ever leaves this process: `computer.action` carries "<12 characters>" where the text
// was. The card then says "type 12 characters", which is less than the user might like to see, and never more
// than is safe.
//
// What is redacted: any string under a key that carries text (`text`, `value`, `content`, `password`, `secret`,
// `clipboard`), anywhere in the arguments, and a single printable character pressed as a key (`press_key` with
// `key: "s"`), because typing a password one key at a time is still typing a password. Named keys (`Enter`,
// `ctrl+c`) stay: they are what the user needs to read on the card, and they are not secrets.

use rmcp::model::JsonObject;
use serde_json::Value;

const TEXT_KEYS: &[&str] = &[
    "text",
    "value",
    "content",
    "password",
    "secret",
    "clipboard",
];
const KEY_KEYS: &[&str] = &["key", "keys"];

/// The arguments with every possibly secret string replaced by its length.
pub fn redact(args: &JsonObject) -> Value {
    Value::Object(
        args.iter()
            .map(|(k, v)| (k.clone(), redact_value(k, v)))
            .collect(),
    )
}

fn redact_value(key: &str, value: &Value) -> Value {
    let key = key.to_ascii_lowercase();
    match value {
        Value::String(s) if TEXT_KEYS.contains(&key.as_str()) => hidden(s),
        Value::String(s) if KEY_KEYS.contains(&key.as_str()) && s.chars().count() == 1 => hidden(s),
        Value::Array(items) => Value::Array(items.iter().map(|v| redact_value(&key, v)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), redact_value(k, v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn hidden(s: &str) -> Value {
    let n = s.chars().count();
    Value::String(format!("<{n} character{}>", if n == 1 { "" } else { "s" }))
}

/// The pixel point an act aims at, if it has one (`x` and `y`).
pub fn point(args: &JsonObject) -> Option<mewndo_proto::Point> {
    let num = |k: &str| args.get(k)?.as_f64().filter(|n| n.is_finite());
    Some(mewndo_proto::Point {
        x: num("x")?.round() as i32,
        y: num("y")?.round() as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> JsonObject {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn typed_text_never_leaves_only_its_length() {
        let secret = "hunter2 correct horse";
        let out = redact(&obj(
            json!({"text": secret, "session": "s", "target": {"kind": "window", "pid": 4}}),
        ));
        let shown = out.to_string();
        assert!(
            !shown.contains("hunter2") && !shown.contains("horse"),
            "{shown}"
        );
        assert_eq!(out["text"], "<21 characters>");
        assert_eq!(out["session"], "s", "labels and targets stay");
        assert_eq!(out["target"]["pid"], 4);

        let nested = redact(&obj(
            json!({"steps": [{"value": "pässwörd"}, {"key": "Enter"}]}),
        ));
        assert_eq!(
            nested["steps"][0]["value"], "<8 characters>",
            "counted in characters, not bytes"
        );
        assert_eq!(nested["steps"][1]["key"], "Enter");
        assert_eq!(
            redact(&obj(json!({"content": "x"})))["content"],
            "<1 character>"
        );
    }

    #[test]
    fn a_single_character_key_is_hidden_and_named_keys_are_not() {
        assert_eq!(redact(&obj(json!({"key": "s"})))["key"], "<1 character>");
        assert_eq!(redact(&obj(json!({"key": "Enter"})))["key"], "Enter");
        let hotkey = redact(&obj(json!({"keys": ["ctrl", "c"]})));
        assert_eq!(hotkey["keys"][0], "ctrl");
        assert_eq!(
            hotkey["keys"][1], "<1 character>",
            "the letter of a chord is still a typed letter"
        );
    }

    #[test]
    fn the_point_of_an_act() {
        assert_eq!(
            point(&obj(json!({"x": 10.4, "y": 20.6}))),
            Some(mewndo_proto::Point { x: 10, y: 21 })
        );
        assert_eq!(point(&obj(json!({"element_token": "s0000002a:22"}))), None);
        assert_eq!(point(&obj(json!({"x": "10", "y": 2}))), None);
    }
}
