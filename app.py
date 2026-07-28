import io

import pandas as pd
import streamlit as st 


COLUMN_ALIASES = {
    'first_name': ['first_name', 'firstname', 'contact_first_name'],
    'last_name': ['last_name', 'lastname', 'contact_last_name'],
    'employer': ['employer', 'company_name', 'company', 'account_name'],
    'phone': ['phone', 'direct_phone_number', 'direct_phone', 'mobile_phone',
              'phone_number', 'contact_phone'],
    'email': ['email', 'email_address', 'contact_email'],
    'job_title': ['job_title', 'title'],
    'state': ['state', 'person_state', 'contact_state', 'person_state/province'],
    'graduation_year': ['graduation_year', 'grad_year'],
    'years_of_experience': ['years_of_experience', 'total_years_experience'],
    'years_at_current_employer': ['years_at_current_employer', 'years_at_company',
                                  'tenure_at_current_company'],
    'number_of_companies': ['number_of_companies', 'company_count'],
    'retirement_intent': ['retirement_intent', 'intent', 'intent_topic'],
}


def smart_read(uploaded_file):
    """Read a ZoomInfo CSV, handling junk 'Column1,Column2...' header rows,
    empty columns, and varying column names."""
    raw = uploaded_file.read()
    buf = io.BytesIO(raw)
    df = pd.read_csv(buf, header=0, low_memory=False)

    # Excel exports sometimes put a placeholder row (Column1, Column2, ...)
    # above the real headers. Detect it and re-read with the second row as header.
    placeholder = sum(
        1 for c in df.columns[:20] if str(c).strip().lower().startswith('column')
    ) >= 10
    if placeholder:
        buf = io.BytesIO(raw)
        df = pd.read_csv(buf, header=1, low_memory=False)

    # Drop fully empty / unnamed columns and fully empty rows
    df = df.dropna(axis=1, how='all')
    df = df[[c for c in df.columns if not str(c).lower().startswith('unnamed')]]
    df = df.dropna(how='all')

    # Normalize column names
    df.columns = [str(c).strip().lower().replace(' ', '_') for c in df.columns]

    # Map known ZoomInfo variants to standard names
    rename = {}
    for std, options in COLUMN_ALIASES.items():
        if std in df.columns:
            continue
        for opt in options:
            if opt in df.columns:
                rename[opt] = std
                break
    df = df.rename(columns=rename)
    return df


def qualify_leads(df):
    """Score and bucket leads into 4 tiers using whatever columns are present."""
    df['qualification_score'] = 0
    df['score_breakdown'] = ''

    for idx, row in df.iterrows():
        score = 0
        breakdown = []

        # AGE INFERENCE
        if 'graduation_year' in df.columns and pd.notna(row.get('graduation_year')):
            try:
                grad_year = int(float(row['graduation_year']))
                age = 2026 - (grad_year - 22)
                if 50 <= age <= 65:
                    score += 25
                    breakdown.append(f"Age ~{age} (ideal)")
            except (ValueError, TypeError):
                pass

        if 'years_of_experience' in df.columns and pd.notna(row.get('years_of_experience')):
            try:
                yoe = int(float(row['years_of_experience']))
                if 28 <= yoe <= 43:
                    score += 20
                    breakdown.append(f"YOE {yoe} (ideal range)")
            except (ValueError, TypeError):
                pass

        # INCOME SIGNAL (job title seniority)
        if 'job_title' in df.columns and pd.notna(row.get('job_title')):
            title = str(row['job_title']).lower()
            senior_keywords = ['ceo', 'cfo', 'coo', 'cto', 'chief', 'svp', 'evp',
                               'vice president', 'vp', 'partner', 'principal',
                               'owner', 'managing director', 'executive', 'director',
                               'president', 'head of']
            if any(keyword in title for keyword in senior_keywords):
                score += 20
                breakdown.append("Senior title (likely $250K+ income)")

        # INVESTABLE ASSETS SIGNAL
        if 'company_size' in df.columns and pd.notna(row.get('company_size')):
            size = str(row['company_size']).lower()
            if any(k in size for k in ['large', '5000+', '1000-5000', 'enterprise']):
                score += 10
                breakdown.append("Large company (asset potential)")

        # ORPHANED 401K SIGNAL
        if 'years_at_current_employer' in df.columns and pd.notna(row.get('years_at_current_employer')):
            try:
                yace = int(float(row['years_at_current_employer']))
                if 'years_of_experience' in df.columns and pd.notna(row.get('years_of_experience')):
                    yoe = int(float(row['years_of_experience']))
                    prior_tenure = yoe - yace
                    if 1 <= yace <= 5 and prior_tenure >= 10:
                        score += 25
                        breakdown.append(f"Recent move ({yace}yr) after long prior role")
                    elif yace > 5:
                        score -= 5
                        breakdown.append(f"Long tenure ({yace}yr) - less orphaned 401K potential")
            except (ValueError, TypeError):
                pass

        # JOB HOPPING CAUTION
        if 'number_of_companies' in df.columns and pd.notna(row.get('number_of_companies')):
            try:
                num_companies = int(float(row['number_of_companies']))
                if num_companies > 5 and 'years_of_experience' in df.columns and pd.notna(row.get('years_of_experience')):
                    yoe = int(float(row['years_of_experience']))
                    if yoe / num_companies < 3:
                        score -= 15
                        breakdown.append("Frequent job hopper - deprioritize")
            except (ValueError, TypeError, ZeroDivisionError):
                pass

        # INTENT SIGNAL
        if 'retirement_intent' in df.columns and pd.notna(row.get('retirement_intent')):
            intent = str(row['retirement_intent']).lower()
            if any(k in intent for k in ['yes', 'true', 'interested', 'retirement']):
                score += 20
                breakdown.append("Retirement planning intent confirmed")

        # CONTACTABILITY (has phone and/or email)
        has_phone = 'phone' in df.columns and pd.notna(row.get('phone'))
        has_mobile = 'mobile_phone' in df.columns and pd.notna(row.get('mobile_phone'))
        has_email = 'email' in df.columns and pd.notna(row.get('email'))
        if has_phone or has_mobile:
            score += 5
            breakdown.append("Phone on file")
        if has_email:
            score += 5
            breakdown.append("Email on file")
        if not (has_phone or has_mobile or has_email):
            score -= 20
            breakdown.append("No contact info - cannot reach")

        # LOCATION CHECK (exclude CT and MA)
        if 'state' in df.columns and pd.notna(row.get('state')):
            state = str(row['state']).strip().upper()
            if state in ['CT', 'MA', 'CONNECTICUT', 'MASSACHUSETTS']:
                score -= 100
                breakdown.append("EXCLUDED: CT or MA")

        df.at[idx, 'qualification_score'] = max(0, score)
        df.at[idx, 'score_breakdown'] = '; '.join(breakdown) if breakdown else 'No qualifying signals'

    df['bucket'] = pd.cut(df['qualification_score'],
                          bins=[-1, 14, 29, 44, 500],
                          labels=['Not Good', 'Maybe', 'Good', 'Ideal Client'])

    return df.sort_values('qualification_score', ascending=False)


# ------------------------- Streamlit UI -------------------------
st.set_page_config(page_title="Lead Qualifier", layout="wide")

st.title("Lead Qualification Tool")
st.write("Upload your ZoomInfo CSV and automatically qualify leads into 4 tiers.")

uploaded_file = st.file_uploader("Upload CSV file", type=['csv'])

if uploaded_file is not None:
    try:
        df = smart_read(uploaded_file)
    except Exception as e:
        st.error(f"Could not read that file: {e}")
        st.stop()

    st.write(f"**Loaded {len(df)} leads** with columns: {', '.join(df.columns[:12])}")

    # Only names are strictly required; everything else is optional
    required_cols = ['first_name', 'last_name']
    missing = [col for col in required_cols if col not in df.columns]

    if missing:
        st.error(f"Missing required columns: {', '.join(missing)}. "
                 "Check that your export includes contact names.")
    else:
        nice_to_have = ['employer', 'phone', 'email', 'job_title', 'state']
        absent = [c for c in nice_to_have if c not in df.columns]
        if absent:
            st.info(f"Optional columns not found (scoring will adapt): {', '.join(absent)}")

        qualified_df = qualify_leads(df.copy())

        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Ideal Client", len(qualified_df[qualified_df['bucket'] == 'Ideal Client']))
        with col2:
            st.metric("Good", len(qualified_df[qualified_df['bucket'] == 'Good']))
        with col3:
            st.metric("Maybe", len(qualified_df[qualified_df['bucket'] == 'Maybe']))
        with col4:
            st.metric("Not Good", len(qualified_df[qualified_df['bucket'] == 'Not Good']))

        st.subheader("Results by Bucket")

        buckets = ["Ideal Client", "Good", "Maybe", "Not Good"]
        tabs = st.tabs(buckets)

        for tab, bucket in zip(tabs, buckets):
            with tab:
                bucket_df = qualified_df[qualified_df['bucket'] == bucket].copy()
                if len(bucket_df) > 0:
                    display_cols = ['first_name', 'last_name', 'employer', 'job_title',
                                    'state', 'phone', 'email',
                                    'qualification_score', 'score_breakdown']
                    display_cols = [c for c in display_cols if c in bucket_df.columns]
                    st.dataframe(bucket_df[display_cols], use_container_width=True)
                else:
                    st.write(f"No leads in {bucket} bucket")

        st.subheader("Download Results")
        csv = qualified_df.to_csv(index=False)
        st.download_button(
            label="Download Qualified Leads (CSV)",
            data=csv,
            file_name="qualified_leads.csv",
            mime="text/csv"
        )
else:
    st.info("Upload a CSV to get started. The tool auto-detects ZoomInfo column "
            "names like 'First Name', 'Direct Phone Number', 'Email Address', "
            "and 'Person State', and skips junk header rows automatically.")
