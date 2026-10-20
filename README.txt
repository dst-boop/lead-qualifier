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
<function system at 0x7f50164be8e0> found
scrape_state verify: True
Site init SSL verification status: True
scraped 29 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  DC  MissingSchema: Invalid URL '/page/rapid-response': No scheme supplied. Perhaps you meant https:///page/rapid-response?
  FL  IndexError: list index out of range
  GA  JSONDecodeError: Expecting value: line 1 column 1 (char 0)
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#2e4a42475c0059415c4548415c4d4b004a4b584b42415e6e464f594f474700494158': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#2e4a42475c0059
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  JSONDecodeError: Expecting value: line 1 column 1 (char 0)
  NM  AssertionError: 
  OH  ValueError: Could not find JSON data div
  RI  AssertionError: 
  TX  AssertionError: 

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 29 feeds to /home/runner/work/_temp/warn/warn_feeds.json
