local({
  script_file <- tryCatch(
    normalizePath(sys.frame(1)$ofile, mustWork = TRUE),
    error = function(...) ""
  )

  candidate_dirs <- unique(c(
    if (nzchar(script_file)) dirname(script_file),
    file.path(getwd(), "analysis", "farming-db"),
    getwd()
  ))

  for (candidate_dir in candidate_dirs) {
    activate <- file.path(candidate_dir, "renv", "activate.R")
    if (file.exists(activate)) {
      if (requireNamespace("renv", quietly = TRUE)) {
        renv::load(project = candidate_dir)
      } else {
        old_wd <- setwd(candidate_dir)
        on.exit(setwd(old_wd), add = TRUE)
        source("renv/activate.R")
      }
      break
    }
  }
})

required_packages <- c("DBI", "RSQLite", "dplyr", "dbplyr", "lubridate")

missing_packages <- required_packages[!vapply(required_packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing_packages) > 0) {
  stop(
    "Missing R packages: ", paste(missing_packages, collapse = ", "), "\n",
    "Run: install.packages('renv'); renv::restore(project = 'analysis/farming-db')",
    call. = FALSE
  )
}

farming_db_repo_root <- function(start = getwd()) {
  current <- normalizePath(start, mustWork = TRUE)
  repeat {
    if (file.exists(file.path(current, "scripts", "download-farming-db.sh"))) {
      return(current)
    }
    parent <- dirname(current)
    if (identical(parent, current)) {
      stop("Could not find repo root containing scripts/download-farming-db.sh", call. = FALSE)
    }
    current <- parent
  }
}

farming_db_home <- function(repo_root = farming_db_repo_root()) {
  configured <- Sys.getenv("OSI_FARMING_DB_HOME", unset = "")
  if (nzchar(configured)) {
    return(normalizePath(configured, mustWork = FALSE))
  }
  file.path(repo_root, ".local", "farming-db")
}

latest_farming_db_snapshot <- function(gateway, snapshot_root = NULL) {
  if (missing(gateway) || !nzchar(gateway)) {
    stop("gateway is required when db_path is not supplied", call. = FALSE)
  }

  snapshot_root <- snapshot_root %||% file.path(farming_db_home(), "snapshots")
  gateway_dir <- file.path(snapshot_root, gateway)
  if (!dir.exists(gateway_dir)) {
    stop("No snapshots found for gateway: ", gateway, call. = FALSE)
  }

  latest_link <- file.path(gateway_dir, "latest", "farming.db")
  if (file.exists(latest_link)) {
    return(normalizePath(latest_link, mustWork = TRUE))
  }

  snapshot_dirs <- list.dirs(gateway_dir, recursive = FALSE, full.names = TRUE)
  snapshot_dirs <- snapshot_dirs[basename(snapshot_dirs) != "latest"]
  if (length(snapshot_dirs) == 0) {
    stop("No timestamped snapshots found for gateway: ", gateway, call. = FALSE)
  }

  candidates <- file.path(sort(snapshot_dirs), "farming.db")
  candidates <- candidates[file.exists(candidates)]
  if (length(candidates) == 0) {
    stop("No farming.db files found for gateway: ", gateway, call. = FALSE)
  }

  normalizePath(tail(candidates, 1), mustWork = TRUE)
}

`%||%` <- function(left, right) {
  if (is.null(left)) right else left
}

parse_osi_time <- function(value) {
  suppressWarnings(lubridate::ymd_hms(value, tz = "UTC", quiet = TRUE))
}

table_exists <- function(con, table_name) {
  table_name %in% DBI::dbListTables(con)
}

read_table_if_exists <- function(con, table_name, collect = TRUE) {
  if (!table_exists(con, table_name)) {
    return(NULL)
  }

  if (!collect) {
    return(dplyr::tbl(con, table_name))
  }

  out <- dplyr::as_tibble(DBI::dbReadTable(con, table_name))
  if ("recorded_at" %in% names(out)) {
    out$recorded_at_utc <- parse_osi_time(out$recorded_at)
  }
  out
}

device_data_query <- paste(
  "SELECT",
  "  dd.*,",
  "  d.name AS device_name,",
  "  d.type_id AS device_type,",
  "  d.irrigation_zone_id AS zone_id,",
  "  iz.name AS zone_name,",
  "  iz.timezone AS zone_timezone",
  "FROM device_data dd",
  "LEFT JOIN devices d ON d.deveui = dd.deveui",
  "LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id",
  "ORDER BY dd.recorded_at",
  sep = "\n"
)

read_device_data <- function(con, collect = TRUE) {
  if (!table_exists(con, "device_data")) {
    stop("Snapshot does not contain a device_data table", call. = FALSE)
  }

  if (!collect) {
    return(dplyr::tbl(con, dbplyr::sql(paste0("(", device_data_query, ")"))))
  }

  out <- dplyr::as_tibble(DBI::dbGetQuery(con, device_data_query))
  if ("recorded_at" %in% names(out)) {
    out$recorded_at_utc <- parse_osi_time(out$recorded_at)
  }
  out
}

open_device_data <- function(gateway = NULL,
                             db_path = NULL,
                             snapshot_root = NULL,
                             collect = TRUE) {
  resolved_db_path <- db_path %||% latest_farming_db_snapshot(gateway, snapshot_root)
  resolved_db_path <- normalizePath(resolved_db_path, mustWork = TRUE)

  con <- DBI::dbConnect(
    RSQLite::SQLite(),
    dbname = resolved_db_path,
    flags = RSQLite::SQLITE_RO
  )

  disconnect <- function() {
    if (DBI::dbIsValid(con)) {
      DBI::dbDisconnect(con)
    }
    invisible(TRUE)
  }

  tryCatch(
    {
      result <- list(
        gateway = gateway,
        db_path = resolved_db_path,
        connection = con,
        device_data = read_device_data(con, collect = collect),
        devices = read_table_if_exists(con, "devices", collect = collect),
        irrigation_zones = read_table_if_exists(con, "irrigation_zones", collect = collect),
        dendrometer_readings = read_table_if_exists(con, "dendrometer_readings", collect = collect),
        chameleon_readings = read_table_if_exists(con, "chameleon_readings", collect = collect),
        disconnect = disconnect
      )
      class(result) <- c("osi_farming_db", class(result))
      result
    },
    error = function(err) {
      disconnect()
      stop(err)
    }
  )
}
