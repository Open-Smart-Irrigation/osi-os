"""Pin archive bytes in the runner's private scratch before consuming them."""
import hashlib
import shutil


def verified_archive(source, digest, destination, *, label):
    with source.open('rb') as original, destination.open('x+b') as staged:
        try:
            shutil.copyfileobj(original, staged)
            staged.seek(0)
            if hashlib.file_digest(staged, 'sha256').hexdigest() != digest:
                raise ValueError(f'{label} SHA-256 mismatch')
        except BaseException:
            destination.unlink(missing_ok=True)
            raise
    destination.chmod(0o400)
    return destination
