//! Folders: postings kept together because they belong together.
//!
//! A label marks a posting and a category files it. A folder does neither —
//! it *holds* postings, by hand, for as long as the thing they are about is
//! going on. The Goa trip, the kitchen, a year of one client's invoices:
//! runs of spending that cut across every category and account the book has,
//! and that no rule could gather because the only thing they have in common
//! is that you say so.
//!
//! Nothing is stored twice. A folder keeps ids and the postings stay where
//! they are, so correcting one corrects what the folder says about it, and
//! deleting one takes it out of every folder that held it. A posting can sit
//! in as many folders as you like: a flight to Goa is both the trip and the
//! year's travel, and making you choose would be making you file it twice.

use rusqlite::{params, params_from_iter, Connection};

use crate::db::{new_id, now, oops, placeholders, Result, NOT_A_REFUND, REFUNDED};
use crate::models::{Folder, FolderInput};

/// Every folder, with what is in it and what it comes to.
///
/// The figures are the ledger's own — a refund and the posting it gives back
/// cancel — so a folder never disagrees with the screen you gathered it from.
/// An empty folder still comes back: it is a folder you have just made and
/// are about to fill, not a folder that failed to exist.
pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>> {
    let sql = format!(
        "SELECT f.id, f.name, f.color, f.icon, f.note, f.created_at,
                COUNT(t.id),
                COALESCE(SUM(CASE WHEN t.kind = 'income'  AND {NOT_A_REFUND}
                                  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND {NOT_A_REFUND}
                                  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'transfer' THEN t.amount ELSE 0 END), 0),
                MIN(t.occurred_at), MAX(t.occurred_at)
         FROM folders f
         LEFT JOIN folder_transactions ft ON ft.folder_id = f.id
         LEFT JOIN transactions t ON t.id = ft.transaction_id
         GROUP BY f.id
         ORDER BY f.name COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql).map_err(oops)?;
    let rows = stmt
        .query_map([], folder_from_row)
        .map_err(oops)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(oops)?;
    Ok(rows)
}

fn folder_from_row(r: &rusqlite::Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        icon: r.get(3)?,
        note: r.get(4)?,
        created_at: r.get(5)?,
        count: r.get(6)?,
        income: r.get(7)?,
        expense: r.get(8)?,
        transferred: r.get(9)?,
        first_at: r.get(10)?,
        last_at: r.get(11)?,
    })
}

/// One folder as it stands, for the page that shows it.
pub fn get_folder(conn: &Connection, id: &str) -> Result<Folder> {
    let sql = format!(
        "SELECT f.id, f.name, f.color, f.icon, f.note, f.created_at,
                COUNT(t.id),
                COALESCE(SUM(CASE WHEN t.kind = 'income'  AND {NOT_A_REFUND}
                                  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'expense' AND {NOT_A_REFUND}
                                  THEN t.amount - {REFUNDED} ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN t.kind = 'transfer' THEN t.amount ELSE 0 END), 0),
                MIN(t.occurred_at), MAX(t.occurred_at)
         FROM folders f
         LEFT JOIN folder_transactions ft ON ft.folder_id = f.id
         LEFT JOIN transactions t ON t.id = ft.transaction_id
         WHERE f.id = ?1
         GROUP BY f.id"
    );
    conn.query_row(&sql, params![id], folder_from_row)
        .map_err(|_| "That folder is gone.".to_string())
}

pub fn save_folder(conn: &Connection, input: FolderInput) -> Result<Folder> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("A folder needs a name.".into());
    }
    let note = input.note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let taken = |e: rusqlite::Error| {
        if e.to_string().contains("UNIQUE") {
            format!("There is already a folder called \"{name}\".")
        } else {
            e.to_string()
        }
    };
    let id = match input.id.filter(|i| !i.is_empty()) {
        Some(id) => {
            conn.execute(
                "UPDATE folders SET name = ?2, color = ?3, icon = ?4, note = ?5 WHERE id = ?1",
                params![id, name, input.color, input.icon, note],
            )
            .map_err(taken)?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO folders (id, name, color, icon, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, name, input.color, input.icon, note, now()],
            )
            .map_err(taken)?;
            id
        }
    };
    get_folder(conn, &id)
}

/// The folder goes and what was in it stays. A folder is a way of reading the
/// ledger, not a place the money lives: emptying one changes nothing about a
/// single posting it held.
pub fn delete_folder(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(oops)?;
    Ok(())
}

/// Puts postings in a folder, and says how many were not already in it — so
/// gathering the same run twice reports the truth rather than a second lot.
pub fn add_postings(conn: &Connection, folder_id: &str, ids: &[String]) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    // The folder has to exist before anything is put in it.
    get_folder(conn, folder_id)?;
    let guard = conn.unchecked_transaction().map_err(oops)?;
    let stamp = now();
    let mut added = 0;
    for id in ids {
        added += conn
            .execute(
                "INSERT OR IGNORE INTO folder_transactions (folder_id, transaction_id, added_at)
                 VALUES (?1, ?2, ?3)",
                params![folder_id, id, stamp],
            )
            .map_err(oops)? as i64;
    }
    guard.commit().map_err(oops)?;
    Ok(added)
}

/// Takes postings back out. The postings themselves are untouched — this only
/// says they were not what the folder is about.
pub fn remove_postings(conn: &Connection, folder_id: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let ph = placeholders(ids.len());
    let sql = format!(
        "DELETE FROM folder_transactions
         WHERE folder_id = ? AND transaction_id IN ({ph})"
    );
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&folder_id];
    for id in ids {
        args.push(id);
    }
    conn.execute(&sql, params_from_iter(args)).map_err(oops)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::models::{AccountInput, Paise, TransactionInput, TransactionQuery};

    /// A book with the schema brought up, the way every module's tests build
    /// one: in memory, migrated, with the foreign keys watching.
    fn book() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn account(conn: &Connection, name: &str, kind: &str, opening: Paise) -> String {
        db::save_account(
            conn,
            AccountInput {
                id: None,
                name: name.into(),
                kind: kind.into(),
                institution: None,
                opening_balance: opening,
                color: "#000000".into(),
                icon: "wallet".into(),
            },
        )
        .unwrap()
        .id
    }

    fn bill(conn: &Connection, account_id: &str, amount: Paise, on: &str) -> String {
        db::save_transaction(
            conn,
            TransactionInput {
                id: None,
                kind: "expense".into(),
                amount,
                account_id: account_id.into(),
                to_account_id: None,
                category_id: None,
                merchant: "Toit".into(),
                note: None,
                occurred_at: on.into(),
                splits: None,
                shares: None,
                label_ids: None,
                refund_of: None,
            },
        )
        .unwrap()
        .id
    }

    fn folder(conn: &Connection, name: &str) -> Folder {
        save_folder(
            conn,
            FolderInput {
                id: None,
                name: name.into(),
                color: "#118AE4".into(),
                icon: "folder".into(),
                note: None,
            },
        )
        .unwrap()
    }

    /// A folder holds postings and counts them the way the ledger does, and
    /// the same posting can sit in two folders without being written twice.
    #[test]
    fn a_folder_holds_postings_and_adds_them_up() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 500_000);
        let one = bill(&conn, &bank, 120_000, "2026-08-15T20:00");
        let two = bill(&conn, &bank, 80_000, "2026-08-17T13:00");

        let goa = folder(&conn, "Goa");
        let travel = folder(&conn, "Travel");
        assert_eq!(add_postings(&conn, &goa.id, &[one.clone(), two.clone()]).unwrap(), 2);
        // Adding what is already in it adds nothing, and says so.
        assert_eq!(add_postings(&conn, &goa.id, &[one.clone()]).unwrap(), 0);
        assert_eq!(add_postings(&conn, &travel.id, &[one.clone()]).unwrap(), 1);

        let listed = list_folders(&conn).unwrap();
        let goa_row = listed.iter().find(|f| f.name == "Goa").unwrap();
        assert_eq!(goa_row.count, 2);
        assert_eq!(goa_row.expense, 200_000);
        assert!(goa_row.first_at.is_some() && goa_row.last_at.is_some());
        assert_eq!(listed.iter().find(|f| f.name == "Travel").unwrap().count, 1);

        // The ledger can be asked for a folder's postings like any other filter.
        let rows = db::list_transactions(
            &conn,
            TransactionQuery { folder_ids: Some(vec![goa.id.clone()]), ..Default::default() },
        )
        .unwrap();
        assert_eq!(rows.len(), 2);

        // Taking one out leaves the posting alone, and leaves the other folder
        // holding it.
        remove_postings(&conn, &goa.id, &[one.clone()]).unwrap();
        assert_eq!(get_folder(&conn, &goa.id).unwrap().count, 1);
        assert_eq!(get_folder(&conn, &travel.id).unwrap().count, 1);
        assert!(db::get_transaction(&conn, &one).is_ok());

        // And deleting the folder leaves every posting that was in it.
        delete_folder(&conn, &goa.id).unwrap();
        assert!(list_folders(&conn).unwrap().iter().all(|f| f.name != "Goa"));
        assert_eq!(
            db::list_transactions(&conn, TransactionQuery::default()).unwrap().len(),
            2
        );
    }

    /// A folder is named once: a second one under the same name is refused
    /// rather than made, and deleting a posting takes it out of what held it.
    #[test]
    fn a_folder_is_named_once_and_follows_the_ledger() {
        let conn = book();
        let bank = account(&conn, "Bank", "bank", 500_000);
        let one = bill(&conn, &bank, 120_000, "2026-08-15T20:00");
        let goa = folder(&conn, "Goa");
        add_postings(&conn, &goa.id, &[one.clone()]).unwrap();

        assert!(save_folder(
            &conn,
            FolderInput {
                id: None,
                name: "  Goa  ".into(),
                color: "#F2724F".into(),
                icon: "plane".into(),
                note: None,
            },
        )
        .is_err());
        // Renaming the one that exists is not a clash with itself.
        let renamed = save_folder(
            &conn,
            FolderInput {
                id: Some(goa.id.clone()),
                name: "Goa, March".into(),
                color: "#F2724F".into(),
                icon: "plane".into(),
                note: Some("  ".into()),
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Goa, March");
        assert_eq!(renamed.note, None, "a note of spaces is no note");
        assert_eq!(renamed.count, 1, "renaming keeps what it holds");

        db::delete_transaction(&conn, &one).unwrap();
        assert_eq!(get_folder(&conn, &goa.id).unwrap().count, 0);
    }
}
