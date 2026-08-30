//! Reading a bank statement into rows the ledger can reason about.
//!
//! Everything here is pure: a file becomes `StatementRow`s, and a narration
//! becomes the key a remembered categorisation is filed under. What those
//! rows do to the book is `db`'s business.

use calamine::{open_workbook_auto, Data, Reader};

use crate::models::{Paise, StatementRow};

type Result<T> = std::result::Result<T, String>;

/// Reads a statement export — HDFC's .xls layout, where transaction rows
/// carry a dd/mm/yy date, a narration, a reference, and one of a withdrawal
/// or a deposit column. Header, address block and footer all fail the date
/// test and fall away on their own.
pub fn parse_statement(path: &str) -> Result<Vec<StatementRow>> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|e| format!("That file could not be read as a spreadsheet: {e}"))?;
    let sheet = workbook
        .worksheet_range_at(0)
        .ok_or("The file has no sheets in it.")?
        .map_err(|e| e.to_string())?;

    let mut rows = Vec::new();
    for row in sheet.rows() {
        let date = match row.first().map(cell_text) {
            Some(d) => match statement_date(d.trim()) {
                Some(iso) => iso,
                None => continue,
            },
            None => continue,
        };
        let narration = row.get(1).map(cell_text).unwrap_or_default().trim().to_string();
        let ref_no = row.get(2).map(cell_text).unwrap_or_default().trim().to_string();
        let withdrawal = row.get(4).and_then(cell_paise);
        let deposit = row.get(5).and_then(cell_paise);
        let balance = row.get(6).and_then(cell_paise);

        // A row with a date but no money is a continuation or a ruling line.
        let (amount, direction) = match (withdrawal, deposit) {
            (Some(w), _) if w > 0 => (w, "debit"),
            (_, Some(d)) if d > 0 => (d, "credit"),
            _ => continue,
        };
        rows.push(StatementRow {
            date,
            narration,
            ref_no,
            amount,
            direction: direction.to_string(),
            balance,
        });
    }
    if rows.is_empty() {
        return Err(
            "No transactions found — this doesn't look like a bank statement export.".into(),
        );
    }
    Ok(rows)
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::String(s) => s.clone(),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        _ => String::new(),
    }
}

/// A money cell as paise. Statements write amounts as floats or as strings;
/// either way the figure is rupees with up to two decimals.
fn cell_paise(cell: &Data) -> Option<Paise> {
    let rupees = match cell {
        Data::Float(f) => *f,
        Data::Int(i) => *i as f64,
        Data::String(s) => {
            let cleaned: String = s.chars().filter(|c| *c != ',' && *c != ' ').collect();
            if cleaned.is_empty() {
                return None;
            }
            cleaned.parse::<f64>().ok()?
        }
        _ => return None,
    };
    Some((rupees * 100.0).round() as Paise)
}

/// `dd/mm/yy` or `dd/mm/yyyy` as an ISO date, or nothing — which is what
/// tells a transaction row from every other line on the sheet.
fn statement_date(text: &str) -> Option<String> {
    let parts: Vec<&str> = text.split('/').collect();
    if parts.len() != 3 {
        return None;
    }
    let day: u32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let year: i32 = parts[2].parse().ok()?;
    let year = if year < 100 { 2000 + year } else { year };
    if !(1..=31).contains(&day) || !(1..=12).contains(&month) || !(2000..=2100).contains(&year) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

// ------------------------------------------------------------- match keys

/// The key a narration files its remembered categorisation under: stable for
/// one counterparty across visits, different between counterparties. A UPI
/// line keys on the VPA, which outlives the per-payment reference numbers
/// around it; other modes key on the name with the noise stripped away.
pub fn match_key(narration: &str) -> Option<String> {
    let n = narration.trim();
    if n.is_empty() {
        return None;
    }
    let upper = n.to_uppercase();

    if let Some(rest) = upper.strip_prefix("UPI-") {
        let segments: Vec<&str> = rest.split('-').collect();
        if let Some(vpa) = segments.iter().find(|s| s.contains('@')) {
            return Some(format!("upi:{}", vpa.trim().to_lowercase()));
        }
        if let Some(name) = segments.first().filter(|s| !s.trim().is_empty()) {
            return Some(format!("upi:{}", name.trim().to_lowercase()));
        }
        return None;
    }

    if upper.starts_with("ACH") {
        // "ACH D- INDIAN CLEARING CORP-000000PKHMUL" — the name is what is
        // left once the debit/credit marker in front and the references go.
        let name = ach_name(&upper);
        if !name.is_empty() {
            return Some(format!("ach:{}", name.to_lowercase()));
        }
    }

    if upper.contains("DC INTL POS TXN MARKUP") {
        return Some("fee:dc-intl-pos-markup".into());
    }

    for mode in ["NEFT", "RTGS", "IMPS"] {
        if upper.starts_with(mode) || upper.starts_with(&format!(".{mode}")) {
            if let Some(name) = counterparty_segment(&upper) {
                return Some(format!("{}:{}", mode.to_lowercase(), name.to_lowercase()));
            }
        }
    }

    if upper.starts_with("POS ") || upper.starts_with(".POS ") {
        // "POS 000000275206 30MAR26 09:54:27 NEW DELHI TATA STARBUCKS" — the
        // card number, the reference, the timestamp all carry digits; the
        // merchant is what doesn't.
        let merchant = pos_merchant(&upper);
        if !merchant.is_empty() {
            return Some(format!("pos:{}", merchant.to_lowercase()));
        }
    }

    // Whatever mode this is, its letters are the stable part of it.
    let letters: String = upper
        .chars()
        .map(|c| if c.is_ascii_alphabetic() || c == ' ' { c } else { ' ' })
        .collect();
    let squeezed: Vec<&str> = letters.split_whitespace().collect();
    if squeezed.is_empty() {
        return None;
    }
    let mut key = squeezed.join(" ").to_lowercase();
    key.truncate(48);
    Some(format!("misc:{}", key.trim_end()))
}

/// The name in an ACH narration: past the "D-"/"C-" marker when one is
/// there, up to the reference, with any token carrying digits dropped.
fn ach_name(upper: &str) -> String {
    let after = upper.get(3..).unwrap_or("").trim_start();
    let after = if (after.starts_with('D') || after.starts_with('C'))
        && matches!(after.as_bytes().get(1), Some(b'-') | Some(b' '))
    {
        after.get(1..).unwrap_or("").trim_start_matches(['-', ' '])
    } else {
        after
    };
    after
        .split('-')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .filter(|tok| !tok.chars().any(|c| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The merchant in a POS narration: every token past "POS" that carries no
/// digit — the card number, reference and timestamp all do.
fn pos_merchant(upper: &str) -> String {
    upper
        .split_whitespace()
        .skip(1)
        .filter(|tok| !tok.chars().any(|c| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The first segment of a dash-separated narration that reads like a name:
/// mostly letters, not an IFSC code, not the transfer mode itself.
fn counterparty_segment(upper: &str) -> Option<String> {
    upper
        .split('-')
        .skip(1)
        .map(str::trim)
        .find(|seg| {
            let letters = seg.chars().filter(|c| c.is_ascii_alphabetic()).count();
            let digits = seg.chars().filter(|c| c.is_ascii_digit()).count();
            letters >= 3 && digits <= letters && !looks_like_ifsc(seg)
        })
        .map(String::from)
}

/// Four letters, a zero, six more characters — the shape of every IFSC code.
fn looks_like_ifsc(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 11
        && b[..4].iter().all(u8::is_ascii_alphabetic)
        && b[4] == b'0'
        && b[5..].iter().all(u8::is_ascii_alphanumeric)
}

/// A merchant worth showing, pulled out of the narration: the counterparty's
/// name in its own case rather than the bank's shouting, with the references
/// left behind.
pub fn display_merchant(narration: &str) -> String {
    let n = narration.trim();
    let upper = n.to_uppercase();

    let raw = if let Some(rest) = n.strip_prefix("UPI-").or_else(|| n.strip_prefix("upi-")) {
        rest.split('-').next().unwrap_or(rest)
    } else if upper.starts_with("ACH") {
        return title_case(&ach_name(&upper));
    } else if upper.contains("DC INTL POS TXN MARKUP") {
        "Card markup fee"
    } else if upper.starts_with("POS ") || upper.starts_with(".POS ") {
        return title_case(&pos_merchant(&upper));
    } else if upper.starts_with("NEFT") || upper.starts_with("RTGS") || upper.starts_with("IMPS")
    {
        return counterparty_segment(&upper)
            .map(|s| title_case(&s))
            .unwrap_or_else(|| title_case(n));
    } else {
        n
    };
    title_case(raw.trim())
}

fn title_case(text: &str) -> String {
    text.split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upi_keys_on_the_vpa() {
        assert_eq!(
            match_key("UPI-BOOKMYSHOW-CP.BOOKMYSHOW@AXIS-UTIB0000100-645826491855-PAYMENT"),
            Some("upi:cp.bookmyshow@axis".into())
        );
    }

    #[test]
    fn ach_keys_on_the_name() {
        assert_eq!(
            match_key("ACH D- INDIAN CLEARING CORP-000000PKHMUL"),
            Some("ach:indian clearing corp".into())
        );
    }

    #[test]
    fn markup_fees_share_one_key() {
        assert_eq!(
            match_key(".DC INTL POS TXN MARKUP+ST 150325 150325-MIR2609278894978"),
            Some("fee:dc-intl-pos-markup".into())
        );
    }

    #[test]
    fn dates_tell_rows_from_furniture() {
        assert_eq!(statement_date("01/04/26"), Some("2026-04-01".into()));
        assert_eq!(statement_date("********"), None);
        assert_eq!(statement_date("Date"), None);
    }

    #[test]
    fn merchants_read_like_names() {
        assert_eq!(
            display_merchant("UPI-MOHD IFTEKHAR AHMED-IFTEKHAR@OKICICI-ICIC0001-645719295926"),
            "Mohd Iftekhar Ahmed"
        );
    }
}
