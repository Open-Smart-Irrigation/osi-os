args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1) {
  stop("Usage: Rscript test-load-device-data.R <path-to-farming.db>", call. = FALSE)
}

script_args <- commandArgs(trailingOnly = FALSE)
file_arg <- grep("^--file=", script_args, value = TRUE)
script_dir <- if (length(file_arg) == 1) {
  dirname(normalizePath(sub("^--file=", "", file_arg), mustWork = TRUE))
} else {
  getwd()
}

source(file.path(script_dir, "load_device_data.R"))

db <- open_device_data(db_path = args[[1]])
on.exit(db$disconnect(), add = TRUE)

expected_rows <- DBI::dbGetQuery(db$connection, "SELECT COUNT(*) AS rows FROM device_data")$rows[[1]]

stopifnot(!"users" %in% names(db))
stopifnot(is.data.frame(db$device_data))
stopifnot(nrow(db$device_data) == expected_rows)
stopifnot(all(c("deveui", "recorded_at", "device_name", "device_type", "zone_id") %in% names(db$device_data)))
stopifnot(inherits(db$device_data$recorded_at_utc, "POSIXct"))

test_gateway <- Sys.getenv("OSI_FARMING_DB_TEST_GATEWAY", unset = "")
if (nzchar(test_gateway)) {
  gateway_db <- open_device_data(gateway = test_gateway)
  on.exit(gateway_db$disconnect(), add = TRUE)
  stopifnot(identical(normalizePath(args[[1]], mustWork = TRUE), gateway_db$db_path))
  stopifnot(nrow(gateway_db$device_data) == expected_rows)
}

cat("R loader opened device_data rows:", nrow(db$device_data), "\n")
