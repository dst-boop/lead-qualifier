AZ cache status: True
AZ SSL verification: True
scrape_state verify: True
Site init SSL verification status: True
scrape_state verify: True
Site init SSL verification status: True
scrape_state verify: True
Site init SSL verification status: True
scrape_state verify: True
Site init SSL verification status: True
<function system at 0x74818d9979c0> found
scrape_state verify: True
Site init SSL verification status: True
scraped 28 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  DC  MissingSchema: Invalid URL '/page/rapid-response': No scheme supplied. Perhaps you meant https:///page/rapid-response?
  FL  IndexError: list index out of range
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#4420282d366a332b362f222b3627216a20213221282b34042c2533252d2d6a232b32': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#4420282d366a33
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site address'
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  RI  UnboundLocalError: cannot access local variable 'headers' where it is not associated with a value
  TN  ConnectionError: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))
  TX  Exception: Scraper isn't scraping.
  WI  AssertionError: 

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 28 feeds to /home/runner/work/_temp/warn/warn_feeds.json
