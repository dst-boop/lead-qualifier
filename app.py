import streamlit as st
import pandas as pd


def qualify_leads(df):
    """
    Lead qualification tool that scores and buckets leads into 4 tiers.
    Works flexibly with whatever columns are provided.
    """

    df['qualification_score'] = 0
    df['score_breakdown'] = ''

    for idx, row in df.iterrows():
        score = 0
        breakdown = []

        # AGE INFERENCE (from graduation year or years of experience)
        if 'graduation_year' in df.columns and pd.notna(row['graduation_year']):
            try:
                grad_year = int(row['graduation_year'])
                birth_year = grad_year - 22
                age = 2026 - birth_year
                if 50 <= age <= 65:
                    score += 25
                    breakdown.append(f"Age ~{age} (ideal)")
            except (ValueError, TypeError):
                pass

        if 'years_of_experience' in df.columns and pd.notna(row['years_of_experience']):
            try:
                yoe = int(row['years_of_experience'])
                if 28 <= yoe <= 43:
                    score += 20
                    breakdown.append(f"YOE {yoe} (ideal range)")
            except (ValueError, TypeError):
                pass

        # INCOME SIGNAL (from job title seniority)
        if 'job_title' in df.columns and pd.notna(row['job_title']):
            title = str(row['job_title']).lower()
            senior_keywords = ['ceo', 'cfo', 'coo', 'cto', 'svp', 'vp', 'partner',
                               'principal', 'owner', 'md', 'managing director',
                               'executive', 'director']
            if any(keyword in title for keyword in senior_keywords):
                score += 20
                breakdown.append("Senior title (likely $250K+ income)")

        # INVESTABLE ASSETS SIGNAL
        if 'company_size' in df.columns and pd.notna(row['company_size']):
            size = str(row['company_size']).lower()
            if any(keyword in size for keyword in ['large', '5000+', '1000-5000', 'enterprise']):
                score += 10
                breakdown.append("Large company (asset potential)")

        # ORPHANED 401K SIGNAL
        if 'years_at_current_employer' in df.columns and pd.notna(row['years_at_current_employer']):
            try:
                yace = int(row['years_at_current_employer'])
                if 'years_of_experience' in df.columns and pd.notna(row['years_of_experience']):
                    yoe = int(row['years_of_experience'])
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
        if 'number_of_companies' in df.columns and pd.notna(row['number_of_companies']):
            try:
                num_companies = int(row['number_of_companies'])
                if num_companies > 5 and 'years_of_experience' in df.columns and pd.notna(row['years_of_experience']):
                    yoe = int(row['years_of_experience'])
                    avg_tenure = yoe / num_companies
                    if avg_tenure < 3:
                        score -= 15
                        breakdown.append("Frequent job hopper - deprioritize")
            except (ValueError, TypeError, ZeroDivisionError):
                pass

        # INTENT SIGNAL
        if 'retirement_intent' in df.columns and pd.notna(row['retirement_intent']):
            intent = str(row['retirement_intent']).lower()
            if 'yes' in intent or 'true' in intent or 'interested' in intent:
                score += 20
                breakdown.append("Retirement planning intent confirmed")

        # LOCATION CHECK (exclude CT and MA)
        if 'state' in df.columns and pd.notna(row['state']):
            state = str(row['state']).strip().upper()
            if state in ['CT', 'MA', 'CONNECTICUT', 'MASSACHUSETTS']:
                score -= 100
                breakdown.append("EXCLUDED: CT or MA")

        df.at[idx, 'qualification_score'] = max(0, score)
        df.at[idx, 'score_breakdown'] = '; '.join(breakdown) if breakdown else 'No qualifying signals'

    # Bucket leads into 4 tiers
    df['bucket'] = pd.cut(df['qualification_score'],
                          bins=[-1, 24, 49, 74, 200],
                          labels=['Not Good', 'Maybe', 'Good', 'Ideal Client'])

    df = df.sort_values('qualification_score', ascending=False)

    return df


# Streamlit UI
st.set_page_config(page_title="Lead Qualifier", layout="wide")

st.title("Lead Qualification Tool")
st.write("Upload your ZoomInfo CSV and automatically qualify leads into 4 tiers.")

uploaded_file = st.file_uploader("Upload CSV file", type=['csv'])

if uploaded_file is not None:
    df = pd.read_csv(uploaded_file)

    st.write(f"**Loaded {len(df)} leads**")

    # Standardize column names to lowercase
    df.columns = [col.lower().strip() for col in df.columns]

    required_cols = ['first_name', 'last_name', 'employer', 'phone', 'email']
    missing = [col for col in required_cols if col not in df.columns]

    if missing:
        st.error(f"Missing required columns: {', '.join(missing)}")
    else:
        qualified_df = qualify_leads(df.copy())

        # Summary metrics
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
                                    'qualification_score', 'score_breakdown']
                    display_cols = [col for col in display_cols if col in bucket_df.columns]
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

        with st.expander("Column Mapping Guide"):
            st.write("""
            **Required columns (must be in your CSV):**
            - first_name
            - last_name
            - employer
            - phone
            - email

            **Optional columns for better scoring:**
            - graduation_year
            - years_of_experience
            - job_title
            - company_size
            - years_at_current_employer
            - number_of_companies
            - retirement_intent
            - state

            The tool automatically detects these columns and uses them for scoring.
            """)
else:
    st.info("Upload a CSV file to get started. Required columns: first_name, last_name, employer, phone, email")
